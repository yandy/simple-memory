import { randomBytes, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

/**
 * 这台机器的设备身份，落在 `<syncRoot>/device.json`。
 *
 * 它只服务两件事：**同步提交的作者**（于是用户那个私有仓库的 `git log` 能看出哪台机器写了什么），
 * 与后续 `status` 报告里那行「你是哪台设备」。因此 `id` 必须在多次运行之间保持不变 ——
 * 每次启动换一个，提交作者与报告就都成了噪声，人也没法据此判断一条改动来自哪台机器。
 * 「跨进程稳定」是本模块存在的**全部**理由：只在同一个进程内稳定，一个模块级缓存就能做到，
 * 那对提交作者毫无意义。
 *
 * **`id` 绝不参与冲突副本的命名。** 另存为新条目的名字必须完全由冲突内容的字节派生
 * （见 `conflict.ts`）：两台设备各自独立收敛同一次冲突，只有名字是内容的确定性函数，
 * 它们才能算出逐字节相同的文件名、收敛成一条。一旦设备 id 漏进派生名字，两台设备就会
 * 各造一份副本，下一轮再互相把对方的副本拉过来 —— 同一条记忆变成三份、四份，永不收敛。
 * 所以本模块的产物只用于「谁提交的」与「给人看的报告」，不进入任何名字推导。
 *
 * 它本身**不同步**：每台设备有自己的身份，把 `device.json` 推到远端等于让两台机器共用一个 id。
 */
export interface DeviceIdentity {
	/** 持久 id：这台机器的身份，创建后不再变（我们写出去的是 uuid，但读回时不强制这个形状）。 */
	id: string;
	/** 创建那一刻的主机名，纯粹给人看（唯一性不依赖它）。 */
	hostname: string;
	/** 身份创建时刻，ISO 字符串。 */
	createdAt: string;
}

/** `<syncRoot>/device.json`。`syncRoot` 就是记忆根下的 `.sync` 目录。 */
export function devicePath(syncRoot: string): string {
	return join(syncRoot, "device.json");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 只认 `Date#toISOString` 那种形态（我们写的就是它）：不是「任意能被 Date 解析的字符串」。 */
function isIsoInstant(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const ms = Date.parse(value);
	return !Number.isNaN(ms) && new Date(ms).toISOString() === value;
}

/**
 * 身份字段（`id` 与 `hostname`）的长度上限。
 *
 * 这个上限不服务于合法性，只服务于**可读性**：两个字段都会进 git 提交作者与 `status` 文案，
 * 而这两处都按短标识设计。一个几 KB 的身份会让提交头的作者栏与报告第一屏全是它。
 */
const MAX_IDENTITY_FIELD_LENGTH = 128;

/**
 * C0（含 `\n`、`\r`、`\t`、`ESC`）与 DEL、C1 控制字符：逐字写出去的 `ESC[31m` 会在终端里
 * 把状态报告染色（或更糟，清屏），换行会把一行报告、一行提交头拆成两行。
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * 身份字段的形状**下限**：非空、非纯空白、无控制字符、长度 ≤ 128。
 *
 * 刻意只是下限，**不要求 uuid 形状**：手工改过但仍可用的身份不该被换掉 —— 换掉才是提交作者
 * 漂移的原因，而这一整条链（提交作者、报告）唯一在乎的是「稳定」。所以 `device-a` 这种手写值
 * 照样接受，只把「当不了作者标识」的值挡在外面：空串会让提交作者变空，纯空白会被 git 当作无作者，
 * 控制字符会被 git 拒掉或让报告乱码。
 */
function isUsableIdentityField(value: unknown): value is string {
	if (typeof value !== "string") return false;
	if (value.length === 0 || value.length > MAX_IDENTITY_FIELD_LENGTH) return false;
	// trim 之后再判空：`" "` 不是身份，而 `" device-a"` 是（原样保留，不替用户改值）。
	if (value.trim().length === 0) return false;
	return !CONTROL_CHARS.test(value);
}

/**
 * 把解析出来的 JSON 收窄成 `DeviceIdentity`；任一处不对返回 `null`。
 *
 * 逐个字段查是刻意的：`device.json` 是人可能手改、云盘可能半截落盘的文件，而它是**身份**。
 * 半信半疑地接受一个残缺身份，比重新生成一份更糟 —— 缺 `id` 的身份会让提交作者变空，
 * 缺 `createdAt` 会让报告露馅。`id` / `hostname` 的判据见 `isUsableIdentityField`。
 */
function asDeviceIdentity(value: unknown): DeviceIdentity | null {
	if (!isPlainObject(value)) return null;

	const { id, hostname: host, createdAt } = value;
	if (!isUsableIdentityField(id)) return null;
	if (!isUsableIdentityField(host)) return null;
	if (!isIsoInstant(createdAt)) return null;

	return { id, hostname: host, createdAt };
}

/**
 * 读到的三种状态。区分「文件不存在」与「文件在那儿但不能用」是本模块的核心：
 * 前者该创建，后者只该**替换坏内容**，而「读不了」（权限、IO、网络盘）既不是前者也不是后者，
 * 它必须上抛。
 */
type DeviceRead = { kind: "ok"; device: DeviceIdentity } | { kind: "absent" } | { kind: "invalid" };

/**
 * 读已存在的身份。
 *
 * **只有 `ENOENT` / `ENOTDIR`（确实没有这个文件）算 `absent`；其他 errno 一律上抛。**
 * 这是数据安全线，不是风格问题：`EACCES` / `EIO` / 网络挂载抖动都不是「没有身份」，把它们
 * 当成「没有」就会走进创建分支、覆盖掉一份合法身份文件，然后返回一个新 `id` ——
 * 提交作者被**静默重铸**，正是本模块注释反对的那件事。抛出去之后调用方至少能看到失败。
 * （`EISDIR` 同理上抛：目标是个目录，靠猜不如报错。）
 *
 * 内容问题（JSON 坏掉、不是对象、字段不全、`createdAt` 形状不对）才算 `invalid`：
 * 那些是「这个文件的字节当不了身份」，重写一份无损。
 */
async function readDevice(path: string): Promise<DeviceRead> {
	const raw = await readFile(path, "utf8").catch((err: unknown) => {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return null;
		throw err;
	});
	if (raw === null) return { kind: "absent" };

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { kind: "invalid" };
	}

	const device = asDeviceIdentity(parsed);
	return device === null ? { kind: "invalid" } : { kind: "ok", device };
}

/** 同目录下的临时文件名：`<path>.tmp-<pid>-<随机>`，不带目录层级，发布因此不会跨卷。 */
function tempPath(path: string): string {
	return `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
}

/**
 * 把身份写进一个临时文件，返回临时文件路径。
 *
 * `wx`：临时名已带 pid + 随机后缀，正常不会撞。真撞上说明有东西在乱写这个目录，
 * 宁可让 `EEXIST` 冒出来，也不要覆盖别人的临时文件。
 *
 * 先写临时文件再发布，是为了「目标名一旦出现就指向写完整的字节」：记忆根可能就是云盘目录 /
 * 网络盘，直接写目标文件会留下「写了一半的 JSON」这一窗口 —— 撞上它的那次启动读不懂 →
 * 重新生成 → 又有了新 `id`，而两台设备的云盘还在互相覆盖这个文件。
 */
async function writeTemp(path: string, device: DeviceIdentity): Promise<string> {
	await mkdir(dirname(path), { recursive: true });
	const temp = tempPath(path);
	await writeFile(temp, `${JSON.stringify(device, null, "\t")}\n`, { encoding: "utf8", flag: "wx" });
	return temp;
}

/** 发布之后再读一遍盘上内容：调用方拿到的必须是「盘上那份」，而不是「我以为我写了什么」。 */
async function readBack(path: string): Promise<DeviceIdentity> {
	const after = await readDevice(path);
	if (after.kind !== "ok") throw new Error(`写完身份文件之后仍读不出身份：${path}`);
	return after.device;
}

/**
 * 「这个文件系统不支持硬链接」的 errno 集合。
 *
 * 记忆根可能就是网络盘 / FUSE 挂载的云盘目录，那里 `link` 可能直接不支持。那种情况下退回
 * `rename`（覆盖语义），而不是让同步一启动就失败。
 */
const NO_HARDLINK_CODES = new Set(["EPERM", "EACCES", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "EMLINK"]);

/**
 * 目标还不存在（文件确实没有）时创建身份，并把盘上那份返回。
 *
 * 发布用 `link` 而不是 `rename`，因为 `link` **排他**：目标已存在时它原子地失败（`EEXIST`），
 * 于是并发的两个首次运行里只有一个能挂上自己的身份，另一个立刻回到「读盘上那份」——
 * 两边返回同一个 `id`，与盘上一致。
 *
 * `rename` 是无条件覆盖的：并发的两个首次运行各写各的，败者会把赢者刚挂上去的 id 盖掉，
 * 可赢者早已返回了那个 id，那一轮的提交就挂在一个盘上已经不存在的作者上。
 */
async function createDevice(path: string, device: DeviceIdentity): Promise<DeviceIdentity> {
	const temp = await writeTemp(path, device);
	try {
		await link(temp, path);
		return device;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code ?? "";
		if (code === "EEXIST") {
			// 有人抢先了：以盘上那份为准。它是被 `link` 原子挂上去的整份字节，所以这里读得到；
			// 读不到就抛错，绝不覆盖 —— 覆盖等于把别人的身份换掉。
			return readBack(path);
		}
		if (!NO_HARDLINK_CODES.has(code)) throw err;
		// 没有硬链接可用：退回 rename 覆盖，再从盘上读回返回值。这里**失去了排他性** —— 两个并发的
		// 首次运行可能各覆盖一次（窗口极窄，且两边写出的都是合法身份，没人会丢掉可用身份）；返回值
		// 仍取「发布之后盘上那份」，所以不会把一具自己凭空造出、盘上从未存在过的 id 拿去当作者。
		await rename(temp, path);
		return readBack(path);
	} finally {
		// 两条路径都收尾：`link` 成功后临时名还在，`rename` 之后它已不在（ENOENT 忽略即可）。
		await unlink(temp).catch(() => {});
	}
}

/**
 * 文件存在但内容当不了身份（半截落盘的 JSON、手改坏了的字段）时重写一份。
 *
 * 这里是 `rename` 覆盖而不是 `link`：目标名已经被一份**不可用**的字节占着，没有需要保护的
 * 身份，覆盖它是无损的。返回值同样取自盘上（`readBack`），所以「返回的 id 与盘上一致」这条
 * 要求在两条发布路径上都成立。
 */
async function replaceBrokenDevice(path: string, device: DeviceIdentity): Promise<DeviceIdentity> {
	const temp = await writeTemp(path, device);
	try {
		await rename(temp, path);
	} finally {
		await unlink(temp).catch(() => {});
	}
	return readBack(path);
}

/**
 * 读这台设备的身份，没有（或读不懂）就生成一份并落盘。
 *
 * **调用方不需要持有根 sync 锁**：本函数自己收敛。并发的首次运行各自生成，但发布是排他的
 * （见 `createDevice`），所以最终只有一个 `id` 落盘，两个调用方都返回它 —— 不会有人返回一个
 * 盘上已不存在、却已经被拿去当提交作者的 id。加锁只是把这一点从「自己收敛」变成「靠别人」，
 * 而根 sync 锁是 try 语义、允许被跳过的，靠它保证身份的稳定性并不成立。
 *
 * `now` 只为测试能固定 `createdAt`；生产调用不需要传。`syncRoot` 可能还不存在
 * （首次同步时 `.sync` 目录可能还没人建过），这里自己 `mkdir`。
 */
export async function loadOrCreateDevice(
	syncRoot: string,
	now: () => Date = () => new Date(),
): Promise<DeviceIdentity> {
	const path = devicePath(syncRoot);
	await mkdir(syncRoot, { recursive: true });

	const current = await readDevice(path);
	if (current.kind === "ok") return current.device;

	const created: DeviceIdentity = { id: randomUUID(), hostname: hostname(), createdAt: now().toISOString() };
	return current.kind === "absent" ? createDevice(path, created) : replaceBrokenDevice(path, created);
}
