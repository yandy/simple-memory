import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

/**
 * 这台机器的设备身份，落在 `<syncRoot>/device.json`。
 *
 * 它只服务两件事：**同步提交的作者**（于是用户那个私有仓库的 `git log` 能看出哪台机器写了什么），
 * 与后续 `status` 报告里那行「你是哪台设备」。因此 `id` 必须在多次运行之间保持不变 ——
 * 每次启动换一个，提交作者与报告就都成了噪声，人也没法据此判断一条改动来自哪台机器。
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
	/** 持久 uuid：这台机器的身份，创建后不再变。 */
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
 * 把解析出来的 JSON 收窄成 `DeviceIdentity`；任一处不对返回 `null`。
 *
 * 逐个字段查是刻意的：`device.json` 是人可能手改、云盘可能半截落盘的文件，而它是**身份**。
 * 半信半疑地接受一个残缺身份，比重新生成一份更糟 —— 缺 `id` 的身份会让提交作者变空，
 * 缺 `createdAt` 会让报告露馅。
 *
 * `id` 只要求是**非空字符串**，不要求长得像 uuid：我们写出去的一定是 uuid，而读的时候唯一
 * 要紧的是它稳定、能当作者标识。手改过但仍可用的文件不该被扔掉换成新身份（换身份 =
 * 提交作者变掉，与「稳定」这条恰恰相反）。
 */
function asDeviceIdentity(value: unknown): DeviceIdentity | null {
	if (!isPlainObject(value)) return null;

	const { id, hostname: host, createdAt } = value;
	if (typeof id !== "string" || id.length === 0) return null;
	if (typeof host !== "string" || host.length === 0) return null;
	if (!isIsoInstant(createdAt)) return null;

	return { id, hostname: host, createdAt };
}

/** 读已存在的身份；读不懂（不存在、读不到、JSON 坏掉、字段不全）一律 `null` = 该创建了。 */
async function readDevice(path: string): Promise<DeviceIdentity | null> {
	const raw = await readFile(path, "utf8").catch(() => null);
	if (raw === null) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}

	return asDeviceIdentity(parsed);
}

/** 同目录下的临时文件名：`<path>.tmp-<pid>-<随机>`，不带目录层级，`rename` 因此不会跨卷。 */
function tempPath(path: string): string {
	return `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
}

/**
 * 写身份，**原子**：先写同目录临时文件、再 `rename` 覆盖目标。
 *
 * 记忆根可能就是云盘同步目录 / 网络盘：直接写目标文件会留下「写了一半的 JSON」这一窗口，
 * 撞上它的那次启动读不懂 → 重新生成 → 有了新 `id`，而两台设备的云盘还在互相覆盖这个文件。
 * `rename` 在同一目录内是原子的替换，读者要么看到旧文件、要么看到完整的新文件。
 */
async function writeDevice(path: string, device: DeviceIdentity): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temp = tempPath(path);
	await writeFile(temp, `${JSON.stringify(device, null, "\t")}\n`, "utf8");
	await rename(temp, path);
}

/**
 * 读这台设备的身份，没有（或读不懂）就生成一份并落盘。
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

	const existing = await readDevice(path);
	if (existing !== null) return existing;

	const created: DeviceIdentity = { id: randomUUID(), hostname: hostname(), createdAt: now().toISOString() };
	await writeDevice(path, created);
	return created;
}
