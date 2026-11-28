import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (
      err?.code === "ERR_MODULE_NOT_FOUND" &&
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !specifier.endsWith(".js") &&
      context.parentURL !== undefined
    ) {
      const withJs = `${specifier}.js`;
      try {
        await access(fileURLToPath(new URL(withJs, context.parentURL)));
        return await nextResolve(withJs, context);
      } catch {
        // 見つからない場合は元のエラーを送出する。
      }
    }
    throw err;
  }
}
