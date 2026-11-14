import { createHash } from "node:crypto";

/**
 * 内容指纹。**这是端口契约，不是实现细节**：manifest 与三方 diff 直接比较它的输出，
 * 任何 backend（本地目录、对象存储、……）都必须对同样的内容产出同样的值 —— 否则「没变」
 * 会被判成「变了」，每次同步都凭空生出冲突副本。
 *
 * 因此不借用任何 backend 自带的摘要：git 的 blob sha1 掺了 `blob <长度>\0` 头，对象存储的
 * ETag 掺了分片规则，两者不同源、也与这里的值不同源。换算责任在各自的 backend 身上，
 * core 只认这一个函数。
 */
export function sha256Hex(raw: string): string {
	return createHash("sha256").update(raw, "utf8").digest("hex");
}
