/**
 * 同步错误的共同出口：**凭据脱敏 + Error/unknown 归一化**。
 *
 * 这两件事以前在适配层各写一份（两份正则必然分叉，而分叉的那一侧就是把 token 打进日志的那一侧），
 * 本模块是它们的唯一实现：`backend-git` 拼错误文本、宿主渲染通知与报告都走这里。
 *
 * 只导出 `syncErrorMessage`；正则本身由同包的 `backend-git` 经相对路径直接复用（`redactCredentials`），
 * 不从包出口公开 —— 脱敏是出口的性质（每一个渲染结果都干净），不是给调用方拼字符串用的零件。
 */

/**
 * 抹掉 URL 里的口令。
 *
 * `https://user:<token>@host/...` 是 git 官方支持的凭据写法，也是 CI 上免交互推送的常规做法，
 * 而错误文本会被宿主记进日志、被人贴进 issue，**我们拼出来的这一条**必须干净。
 * HTTP(S)（含 git+http 别名）还允许 `https://<token>@host/...`：整个 userinfo 都是秘密，
 * 必须变成 `***`；带冒号的既有 `user:pass` 仍保留用户名、只隐去口令。其它 scheme 继续走
 * 原来的 user:pass 规则，本地路径里的 `:` 与 `@` 不受影响。
 */
export function redactCredentials(text: string): string {
	return text
		.replace(/\b((?:git\+)?https?:\/\/)([^/\s@]+)@/gi, (_whole, scheme: string, userinfo: string) => {
			const colon = userinfo.indexOf(":");
			return colon === -1 ? `${scheme}***@` : `${scheme}${userinfo.slice(0, colon)}:***@`;
		})
		.replace(/(\/\/[^/\s:@]+:)[^@\s]+@/g, "$1***@");
}

/**
 * 把任意抛出物渲染成一条**可展示**的同步错误。
 *
 * `Error` 只取 `message`（宿主打印走的就是它，带上 `Error: ` 前缀等于让同一个原因有两种文本形状）；
 * 其余一律先 `String()` 归一 —— 同步口径里抛出来的不一定是 `Error`（字符串、子进程产物都可能）。
 * 归一之后统一过脱敏：这是所有同步错误文本的最后一站，`args` 里原样带着的远端凭据就到此为止。
 */
export function syncErrorMessage(error: unknown): string {
	return redactCredentials(error instanceof Error ? error.message : String(error));
}
