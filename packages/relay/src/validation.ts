import { RelayError } from "./errors";
import type { LeaseAction, SendFilter } from "./types";

/** lease の操作を検証する（IF §4.5.1）。そうでなければ INVALID_MESSAGE。 */
export function parseLeaseAction(value: unknown): LeaseAction {
  if (value !== "ACQUIRE" && value !== "RENEW" && value !== "RELEASE") {
    throw new RelayError(
      "INVALID_MESSAGE",
      "action must be ACQUIRE, RENEW or RELEASE",
    );
  }
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 空でない文字列であることを検証する。そうでなければ INVALID_MESSAGE。 */
export function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RelayError(
      "INVALID_MESSAGE",
      `${name} must be a non-empty string`,
    );
  }
  return value;
}

/** 0 以上の整数であることを検証する。そうでなければ INVALID_MESSAGE。 */
export function requireSeq(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new RelayError(
      "INVALID_MESSAGE",
      `${name} must be a non-negative integer`,
    );
  }
  return value;
}

function parseStringArray(value: unknown, name: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string")
  ) {
    throw new RelayError(
      "INVALID_MESSAGE",
      `${name} must be a non-empty array of strings`,
    );
  }
  return value;
}

/**
 * 送信対象フィルタを検証する（DD §2.3）。
 * `TYPES` は types が必須（1件以上）。targetIds は、指定する場合は1件以上。
 */
export function parseSendFilter(value: unknown): SendFilter {
  if (!isRecord(value)) {
    throw new RelayError("INVALID_MESSAGE", "sendFilter must be an object");
  }
  const mode = value.mode;
  if (mode !== "ALL" && mode !== "NONE" && mode !== "TYPES") {
    throw new RelayError(
      "INVALID_MESSAGE",
      "sendFilter.mode must be ALL, NONE or TYPES",
    );
  }
  const types =
    value.types === undefined
      ? undefined
      : parseStringArray(value.types, "sendFilter.types");
  const targetIds =
    value.targetIds === undefined
      ? undefined
      : parseStringArray(value.targetIds, "sendFilter.targetIds");
  if (mode === "TYPES" && types === undefined) {
    throw new RelayError(
      "INVALID_MESSAGE",
      "sendFilter.types is required when mode is TYPES",
    );
  }
  return {
    mode,
    ...(types !== undefined ? { types } : {}),
    ...(targetIds !== undefined ? { targetIds } : {}),
  };
}
