/**
 * pluginFiles 分区 adapter（可选，设计 §3.3/§1.2）：
 * 数据源 = 插件自有配置文件（相对 ~/.dsh 根）：
 *   1. 白名单固定文件（dsh-ssh.json、pet.json 等，避免扫描整个主目录）；
 *   2. 约定的插件配置目录（collectDir，如 plugin-config/）递归收集其下所有文件。
 * relativePath 一律是「相对 ~/.dsh 根」的完整路径（与白名单文件一致），
 * 导入时按同一相对路径写回原位置。默认关闭（defaultIncluded=false，用户显式勾选才导出）。
 */
import { sha256Hex } from '../utils/hashing.ts';
import { msgOf, zhMsg } from '../core/messages.ts';
import { linkWarnings, listFilesDetailed } from './link-report.ts';
import type { RecursiveListing } from '../utils/recursive-walk.ts';
import { isPathSafe, isReservedInternalRel } from '../utils/paths.ts';
import type { MsgFunc } from '../core/messages.ts';
import type { FilesSection } from '../schema/types.ts';
import type {
  ApplyResult, ConfigAdapter, ExportOptions, ExportSection, ExportUnit, HostContext,
  ImportContext, PlanItem, ValidationResult,
} from '../core/types.ts';
import { unitAllowed, unitsFromFiles } from './units.ts';
import { sectionMeta } from '../schema/section-registry.ts';
import { validateJsonSection } from './json-section.ts';

export const DEFAULT_PLUGIN_FILE_WHITELIST: readonly string[] = ['dsh-ssh.json', 'pet.json'];

/* —— fork 定制（AutumnPizazz/dsh-config-manager）开始 ——
 * 三处默认值，让「本机自研插件源码 + 插件状态文件」在新机器上零配置随包：
 *   1. DEFAULT_PLUGIN_FILES_DIR = 'plugins'：本机自研插件都住在 ~/.dsh/plugins/ 下，
 *      而且 profile/home patch 行常以 ./plugins/<name>/index.mjs 这类**相对路径**引用它们 ——
 *      plugins 分区只 npm pack `package.json` 里声明的 link:/file: 依赖，覆盖不到这些
 *      「被 patch 行引用的散落文件」，所以缺省就把该目录整收进来。
 *   2. DEFAULT_PLUGIN_FILE_EXCLUDE = ['dsh-ssh.json']：它是明文主机口令，缺省不带。
 *      排除只作用于**默认白名单**；config.pluginFiles 里显式写了就一定会带上。
 *   3. COLLECT_SKIP_DIRS：collectDir 递归收集时跳过的目录。node_modules 是安装产物
 *      （且常含指向 $DSH_HOME 之外的符号链接），换机后由包管理器重建，不该进备份。
 * —— fork 定制结束 —— */
export const DEFAULT_PLUGIN_FILES_DIR = 'plugins';
export const DEFAULT_PLUGIN_FILE_EXCLUDE: readonly string[] = ['dsh-ssh.json'];
const COLLECT_SKIP_DIRS: readonly string[] = ['node_modules'];

export class PluginFilesAdapter implements ConfigAdapter<FilesSection> {
  readonly id = 'pluginFiles' as const;
  // 元数据唯一来源 = 注册表（t31）：不再与 ui/export-flow.ts 的导出目录各写一份
  readonly displayName = sectionMeta('pluginFiles').displayName;
  readonly defaultIncluded = sectionMeta('pluginFiles').defaultIncluded;
  readonly portability = sectionMeta('pluginFiles').portability;
  private readonly whitelist: string[];
  /** 约定配置目录（相对 ~/.dsh 根，如 'plugin-config'）；递归收集其下所有文件。undefined = 不收集。 */
  private readonly collectDir?: string;

  /**
   * @param whitelist 额外白名单文件 —— 与默认白名单**合并**（与 index.d.ts 的 pluginFiles 注释一致）
   * @param collectDir 约定配置目录；undefined = 用 DEFAULT_PLUGIN_FILES_DIR，'' = 不收集
   * @param exclude 从**默认白名单**里剔除的相对路径（显式写进 whitelist 的不受影响）
   */
  constructor(
    whitelist: string[] = [],
    collectDir?: string,
    exclude: readonly string[] = DEFAULT_PLUGIN_FILE_EXCLUDE,
  ) {
    const excluded = new Set(exclude);
    this.whitelist = [...new Set([
      ...DEFAULT_PLUGIN_FILE_WHITELIST.filter((rel) => !excluded.has(rel)),
      ...whitelist,
    ])];
    const dir = collectDir === undefined ? DEFAULT_PLUGIN_FILES_DIR : collectDir;
    if (dir !== '' && !isPathSafe(dir)) {
      throw new Error(`pluginFiles collectDir 非法（须为相对 ~/.dsh 根的安全路径）: ${dir}`);
    }
    this.collectDir = dir === '' ? undefined : dir;
  }

  async export(ctx: HostContext, options: ExportOptions): Promise<ExportSection<FilesSection>> {
    const files: FilesSection['files'] = [];
    const seen = new Set<string>();
    // Phase 1 条目级选择：**逐文件单元** —— 每个插件配置文件彼此独立，
    // 不像技能/会话那样构成 bundle（collectDir 下每个文件可单独带走）。
    const allow = options.includeItems?.[this.id];
    // 1) 白名单固定文件（不存在则跳过，dsh-ssh.json 等为按需创建）
    for (const rel of this.whitelist) {
      if (!unitAllowed(allow, `${this.id}:${rel}`)) continue;
      try {
        const data = await ctx.fs.readFile(rel);
        files.push({ relativePath: rel, data, contentHash: sha256Hex(data) });
        seen.add(rel);
      } catch (err) {
        // ui-F2：白名单文件**不存在**是正常形态（按需创建 → 跳过）；**读不到**（权限/竞态/断链）
        // 绝不能静默丢内容 —— 与文件集合基类同一语义：整分区显式失败，导出报告可见。
        if (await this.absentOnDisk(ctx, rel)) continue;
        throw err;
      }
    }
    // 2) 约定配置目录递归收集（相对 ~/.dsh 根的完整路径；与白名单文件去重）
    // issue #37：与 skills 等同一条遍历（跟随 junction/符号链接 + 跳过留痕）
    let listing: RecursiveListing = { paths: [], skippedLinks: [], followedLinks: 0, unreadableDirs: [] };
    if (this.collectDir !== undefined) {
      try {
        listing = await listFilesDetailed(ctx.fs, this.collectDir);
      } catch {
        // 目录不存在视为空
      }
      // fork 定制：node_modules 是安装产物（换机会重建），且常含指向 $DSH_HOME 之外的符号链接
      const rels = listing.paths.filter((rel) => !rel.split('/').some((seg) => COLLECT_SKIP_DIRS.includes(seg)));
      for (const rel of rels) {
        if (seen.has(rel)) continue;
        if (!unitAllowed(allow, `${this.id}:${rel}`)) continue;
        try {
          const data = await ctx.fs.readFile(rel);
          files.push({ relativePath: rel, data, contentHash: sha256Hex(data) });
        } catch (err) {
          // ui-F2：同上 —— 目录遍历刚点到的文件却读不到，是真实的读取失败，不是「不存在」。
          if (await this.absentOnDisk(ctx, rel)) continue;
          throw err;
        }
      }
    }
    return {
      sectionId: 'pluginFiles',
      data: { version: 1, files },
      counts: { files: files.length },
      warnings: linkWarnings(msgOf(ctx), this.displayName, listing),
    };
  }

  /**
   * 读失败之后判定「这个路径本来就不存在」还是「存在但读不到」（ui-F2）。
   *
   * 为什么不用错误码：门面错误的形状并不统一（内存 mock 与各平台 EACCES 文案不同），
   * 而 `exists()` 是 FileSystemFacade 契约里唯一稳定的存在性判据。`exists()` 自己也失败时
   * 按「存在」处理（保守：宁可让这次导出显式失败，也不静默丢一个文件）。
   */
  private async absentOnDisk(ctx: HostContext, rel: string): Promise<boolean> {
    try {
      return (await ctx.fs.exists(rel)) === false;
    } catch {
      return false;
    }
  }

  /** 单元清单（零 I/O）：逐文件单元，id 与导入侧 `pluginFiles:<relPath>` 一致。 */
  listUnits(section: ExportSection<FilesSection>): ExportUnit[] {
    return unitsFromFiles(this.id, section.data.files, (rel) => rel);
  }

  async analyzeImport(data: FilesSection, ctx: ImportContext): Promise<PlanItem[]> {
    const msg = ctx.msg;
    const items: PlanItem[] = [];
    for (const file of data.files) {
      const id = `pluginFile:${file.relativePath}`;
      // F23 修复：不可信 import 不得写内部 control-plane namespace（snapshots/transactions/locks/safe-mode）
      if (isReservedInternalRel(file.relativePath)) {
        items.push({
          id, kind: 'Error', adapter: 'pluginFiles',
          description: msg('adapter.pluginFileReserved', { path: file.relativePath }), severity: 'error',
        });
        continue;
      }
      let current: Uint8Array | null = null;
      try {
        current = await ctx.target.fs.readFile(file.relativePath);
      } catch {
        current = null;
      }
      if (current === null) {
        items.push({
          id, kind: 'Create', adapter: 'pluginFiles',
          description: msg('adapter.pluginFileCreate', { path: file.relativePath }), severity: 'info',
          target: { adapter: 'pluginFiles', ref: file.relativePath },
        });
      } else if (sha256Hex(current) === file.contentHash) {
        items.push({ id, kind: 'Skip', adapter: 'pluginFiles', description: msg('adapter.fileSame', { path: file.relativePath }), severity: 'info' });
      } else {
        items.push({
          id, kind: 'Conflict', adapter: 'pluginFiles',
          description: msg('adapter.fileDiff', { path: file.relativePath }), severity: 'warning',
          target: { adapter: 'pluginFiles', ref: file.relativePath },
        });
      }
    }
    return items;
  }

  async applyItem(item: PlanItem, ctx: ImportContext): Promise<ApplyResult> {
    const ref = item.target?.ref;
    if (!ref) return { ok: false, message: ctx.msg('adapter.missingTargetRef') };
    // F23 修复：apply 前拒绝写内部 control-plane namespace（纵深防御，analyzeImport 已标 Error）
    if (isReservedInternalRel(ref)) {
      return { ok: false, message: ctx.msg('adapter.pluginFileReserved', { path: ref }) };
    }
    const data = ctx.sections.get('pluginFiles') as FilesSection | undefined;
    const file = data?.files.find((f) => f.relativePath === ref);
    if (!file) return { ok: false, message: ctx.msg('adapter.dataMissingFile', { ref }) };
    await ctx.target.fs.writeFile(ref, file.data);
    return { ok: true };
  }

  async validate(data: FilesSection, msg: MsgFunc = zhMsg): Promise<ValidationResult> {
    return validateJsonSection<FilesSection>('pluginFiles', data, msg, (section, issues) => {
      if (!Array.isArray(section.files)) {
        issues.push({ path: 'files', message: msg('adapter.validate.array', { subject: 'files' }), severity: 'error' });
        return;
      }
      // ui-F3：条目级形状校验必须与 analyzeImport 的假设对齐（它直接读 file.relativePath）。
      // 只校验「是数组」会放过 files:[null] / relativePath:42 这类畸形，analyzeImport 抛内部
      // TypeError → ImportAnalysis.valid=false → 整包被拦下，用户看到的是内部异常文本。
      for (const [i, f] of section.files.entries()) {
        const entry = f as unknown;
        if (entry === null || typeof entry !== 'object' || typeof (entry as { relativePath?: unknown }).relativePath !== 'string' || (entry as { relativePath: string }).relativePath === '') {
          issues.push({ path: `files[${i}]`, message: msg('adapter.validate.fileRelativePath'), severity: 'error' });
        }
      }
    });
  }
}
