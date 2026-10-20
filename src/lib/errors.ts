/**
 * 把底层异常转换成可以展示给玩家的错误信息
 * Node 的 fetch 在网络层失败时只会抛出 "fetch failed"，这里补充上下文
 */
export function describeError(e: unknown): string {
    const message = e instanceof Error ? e.message : String(e);
    if (message === "fetch failed") {
        return "A backend service (database or AI provider) is unreachable. Please try again later.";
    }
    return message || "Unknown server error.";
}
