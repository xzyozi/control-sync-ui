import type { ControlState } from "./types";

/** 初期の制御状態。何も送らない（安全側、DD §2.3）。 */
export const INITIAL_CONTROL: ControlState = {
  sendFilter: { mode: "NONE" },
  holderId: null,
};

/**
 * Control Store（DD F-002）。サーバーから受け取った最新の制御状態と
 * controlSeq を保持する。Domain Store とは分離する（制御状態を変えても
 * ドメイン状態は変化しない）。
 */
export class ControlStore {
  private control: ControlState = INITIAL_CONTROL;
  private seq = 0;

  getControl(): ControlState {
    return this.control;
  }

  getControlSeq(): number {
    return this.seq;
  }

  /**
   * 制御状態を反映する（DD F-002）。保持している値より小さい controlSeq は、
   * 古い応答として反映しない（false を返す）。
   * controlSeq は、0 以上の整数でなければならない（そうでない場合は RangeError）。
   * NaN などを受け入れると、以後の比較が常に false になり、古い応答も反映されるため。
   */
  applyControl(controlSeq: number, control: ControlState): boolean {
    if (!Number.isInteger(controlSeq) || controlSeq < 0) {
      throw new RangeError(`invalid controlSeq: ${controlSeq}`);
    }
    if (controlSeq < this.seq) {
      return false;
    }
    this.seq = controlSeq;
    this.control = control;
    return true;
  }
}
