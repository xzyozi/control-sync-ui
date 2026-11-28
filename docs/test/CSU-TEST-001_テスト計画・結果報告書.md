---
title: "テスト計画・結果報告書"
document_type: "test_plan_report"
document_number: "CSU-TEST-001"
document_role: "evidence"
ssot_scope: "test_evidence"
status: "approved"
version: "0.3"
created_at: "2026-11-28"
updated_at: "2026-11-28"
author: "xzyozi"
owner: "xzyozi"
purpose: "状態同期基盤（v0.1 MVP）の機能テスト要件（IF の TR-001〜013、DD の TR-101〜120）に対応するテストケースと、テストの方式・合格基準を定義し、実装後の結果と証跡を記録するため"
related_documents:
  - "ドキュメントガバナンス（相対パス: ../README.md）"
  - "CSU-REQ-001 最小要件定義書（相対パス: ../features/CSU-REQ-001_最小要件定義書.md）"
  - "CSU-BD-001 基本設計書（相対パス: ../design/CSU-BD-001_基本設計書.md）"
  - "CSU-IF-001 IF/API仕様書（相対パス: ../design/CSU-IF-001_IF仕様書.md）"
  - "CSU-DD-001 詳細設計書（相対パス: ../design/CSU-DD-001_詳細設計書.md）"
  - "CSU-DS-001 データ構造仕様書（相対パス: ../design/CSU-DS-001_データ構造仕様書.md）"
  - "CSU-ENV-001 環境・開発基盤仕様書（相対パス: ../setup/CSU-ENV-001_環境・開発基盤仕様書.md）"
---

# テスト計画・結果報告書
**状態同期基盤 v0.1 MVP：機能テスト要件に対するテストケースと結果**

> 本書は `develop`（`3586ae4`）時点の実装（`core`、`storage-indexeddb`、`transport-http`、`relay`、`demo`）に対する検証結果と証跡を記録する。本書が要求・設計の正本を上書きしてはならない。問題が見つかった場合は、正本を更新する。

---

## 1. 目的・対象範囲

- **目的**: IF/API仕様書の機能テスト要件（TR-001〜013）と、DD の機能テスト要件（TR-101〜120）を、テストケースに対応付け、実装後に検証できる状態にする。
- **テスト対象**: サーバー（v0.1 の参照実装は `relay`）の IF-001〜IF-006、`core`（Domain Store、Control Store、Reactive Outbox、Sync Engine）、`transport-http`（HTTP と SSE の `TransportPort` 実装）、`storage-indexeddb`、`demo`（2画面結合・Chromium E2E・サブモジュール統合テスト）。
- **対象外**: 認証・認可（#8）、複数操作者の競合（#2）、Mailbox（#4）、OPFS（#5）、スナップショット（#6）、スキーマ進化（#7）、UI バインディング（#10）。性能・負荷テストは、v0.1 では実施しない。
- **関連する要求・設計**: [要件定義書](../features/CSU-REQ-001_最小要件定義書.md) の FR-01〜FR-05、NFR-01、NFR-03。[IF/API仕様書](../design/CSU-IF-001_IF仕様書.md) §6、[DD](../design/CSU-DD-001_詳細設計書.md) §5.1。

## 2. テスト戦略・合格基準

- [x] TDD（`core` の純粋なロジック、`relay` の判定ロジック）
- [x] 結合テスト（`core`・`storage-indexeddb`・`transport-http`・`relay` を Node の中で実 HTTP / SSE 通信させる）
- [x] ブラウザ E2E（Google Chrome / Playwright による実 IndexedDB・実 EventSource・実 fetch・`demo` の 2画面／3画面連携）
- [ ] characterization test、性能・負荷、セキュリティ、移行・復旧
- **選択理由**: `core` はブラウザ API に依存しないため、Node で速く検証できる。IF の契約は、`core`・`transport-http`・`relay` の結合で、メッセージの形式と順序を確かめる。IndexedDB と EventSource などのブラウザ固有の挙動は、Playwright による実ブラウザ E2E で検証する。
- **合格基準**: 対象とするすべてのケースが Pass で、未実施・差異がある場合は §6 に理由と代替確認を記録している。
- **適用する品質ゲート**: [環境・開発基盤仕様書](../setup/CSU-ENV-001_環境・開発基盤仕様書.md) の QG-001〜QG-004、QG-007（実行コマンドと合格基準は再掲しない）。
- **使用する証跡**: CI の実行結果（`TypeScript CI`・`Browser E2E`）。

### 2.1 テスト対象のSeam

内部実装ではなく、外部から観測できる公開境界を対象とする。

| Seam / 公開インターフェース                           | 確認する振る舞い                                              | テスト対象外の内部実装                      |
| :---------------------------------------------------- | :------------------------------------------------------------ | :------------------------------------------ |
| サーバーの HTTP と SSE（IF-001〜IF-006）              | メッセージ、エラーコード、HTTP ステータス、`controlSeq`、通知 | サーバー内部のデータ構造、タイマーの実装    |
| `core` の公開 API（接続、切断、イベントの適用、復元） | 状態、送信されるメッセージ、エラーの通知                      | Reducer の内部関数、Outbox の内部の並び替え |
| `StoragePort`（追記、読み出し、送信状態の更新）       | 追記順、Room ごとの読み出し、トランザクションの原子性         | IndexedDB のストアの内部の配置              |

## 3. テスト環境・前提条件

- **環境**: [環境・開発基盤仕様書](../setup/CSU-ENV-001_環境・開発基盤仕様書.md) §3 の CI（`ubuntu-latest`、Node.js LTS）。ブラウザ E2E は `ubuntu-latest` 上の Google Chrome（Playwright 1.52.0 経由）を使用。
- **テストデータ**: テスト用の `roomId`、`targetId`、`operatorId`、イベント（`payload.type` を持つ JSON）。秘密情報や個人情報を含めない。
- **前提条件**: 結合テストおよび E2E では、`relay` をテストごとに独立した Room・状態で起動する。TTL と間隔はテスト用に短縮値を注入する（既定値は DD §1.3）。
- **実行方法**: GitHub Actions（`ci-typescript.yml` による QG-001〜QG-004、`e2e.yml` による `browser-e2e.mjs` および `submodule-integration.mjs`）。

## 4. テストケース

ケース ID は、対応する要件 ID の番号に合わせる（IF の TR-0xx は TC-0xx、DD の TR-1xx は TC-1xx）。期待結果の根拠は、機能テスト要件の ID である。

### 4.1 IF/API仕様書の機能テスト要件（結合テスト・E2E）

| ケースID | 対象・条件                                     | 入力・操作                                                                                                                           | 期待結果                                                                                                           | 期待結果の根拠 | 実績結果                                         | 判定 | 証跡                                                                             |
| :------- | :--------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------- | :------------- | :----------------------------------------------- | :--- | :------------------------------------------------------------------------------- |
| TC-001   | lease を持たない操作者の送信対象フィルタの変更 | lease を取得していない `operatorId` で IF-006 を呼ぶ                                                                                 | `LOCK_NOT_HELD`（403）。`controlSeq` は増加しない。                                                                | TR-001         | 403 `LOCK_NOT_HELD`、状態不変を確認              | Pass | `relay/test/control.test.ts`、`demo/test/protocol-e2e.test.ts`、`browser-e2e.mjs` |
| TC-002   | 送信対象フィルタの変更の連続                   | lease を取得し、IF-006 を複数回呼ぶ                                                                                                  | 応答の `controlSeq` が増加し、重複しない。                                                                         | TR-002         | 連続変更で単調増加・非重複を確認                 | Pass | `relay/test/control.test.ts`、`demo/test/protocol-e2e.test.ts`                   |
| TC-003   | 古い・大きい `controlSeq` のイベント送信       | 最新値より小さい値、大きい値で IF-002 を呼ぶ                                                                                         | 小さい値は `STALE_CONTROL_SEQ`（409。応答に最新値）、大きい値は `INVALID_MESSAGE`（400）。イベントは追加されない。 | TR-003         | 409 / 400 返却とイベント未追加を確認             | Pass | `relay/test/events.test.ts`                                                      |
| TC-004   | 同じ `eventId` の再送                          | 同じ `eventId` で IF-002 を2回呼ぶ                                                                                                   | イベントが二重に追加されない。2回目も受理の応答（最初の `eventSeq`）を返す。                                       | TR-004         | 初回 `eventSeq` 返却と重複排除を確認             | Pass | `relay/test/events.test.ts`                                                      |
| TC-005   | lease の期限切れ                               | lease を取得し、更新せずに TTL を超えて待つ。別の操作者が `ACQUIRE` する                                                             | 期限の時点で解放される。別の操作者が `ACQUIRE` できる。                                                            | TR-005         | タイマー解放と別操作者 `ACQUIRE` を確認          | Pass | `relay/test/lease.test.ts`、`http-server.test.ts`、`protocol-e2e.test.ts`、`browser-e2e.mjs` |
| TC-006   | オフラインの対象端末への変更                   | 更新通知の接続がない、または presence の TTL が切れた `targetId` を指定して IF-006 を呼ぶ                                            | `TARGET_OFFLINE`（409）。変更は適用されず、要求は滞留しない。                                                      | TR-006         | 409 `TARGET_OFFLINE` 即時返却を確認              | Pass | `relay/test/control.test.ts`、`protocol-e2e.test.ts`、`browser-e2e.mjs`          |
| TC-007   | `schemaVersion` の不一致                       | 一致しない `X-Schema-Version` で、IF-001〜IF-006 の各々を呼ぶ                                                                        | `SCHEMA_VERSION_MISMATCH`（400）。サーバーの状態は変化しない。                                                     | TR-007         | 400 拒否と状態不変・クライアント停止を確認       | Pass | `relay/test/envelope-and-rooms.test.ts`、`demo/test/protocol-e2e.test.ts`        |
| TC-008   | Room の分離                                    | Room A で、送信、制御状態の変更、lease を行う。Room B の状態、イベント、通知を確認する                                               | Room B の制御状態、イベント、通知に影響しない。                                                                    | TR-008         | Room 間の非干渉を確認                            | Pass | `relay/test/envelope-and-rooms.test.ts`、`protocol-e2e.test.ts`、`browser-e2e.mjs` |
| TC-009   | 再接続時の Pull の先行                         | 更新通知の接続を開く（初回、自動再接続）。IF-001 が完了する前に、送信を試みる                                                        | 接続が開くたびに IF-001 が実行され、完了する前に IF-002 は実行されない。                                           | TR-009         | ネットワーク順序（IF-001 完了 → IF-002）を確認   | Pass | `core/test/sync-engine.test.ts`、`protocol-e2e.test.ts`、`browser-e2e.mjs`      |
| TC-010   | 保持者の変更と `controlSeq`                    | `ACQUIRE`（新規）、同じ操作者の `ACQUIRE`、`RENEW`、`RELEASE`、期限切れの解放を順に行う                                              | 新規の `ACQUIRE`、`RELEASE`、期限切れで増加し、同じ操作者の `ACQUIRE` と `RENEW` では増加しない。                  | TR-010         | 操作種別ごとの `controlSeq` 増減を確認           | Pass | `relay/test/lease.test.ts`、`demo/test/protocol-e2e.test.ts`                     |
| TC-011   | 更新通知                                       | IF-003 に接続し、IF-006、保持者の変更、IF-002 を行う                                                                                 | `CONTROL_UPDATED` と `EVENTS_APPENDED` が、接続中の対象端末へ通知される。                                          | TR-011         | SSE での通知配信とリアルタイム連携を確認         | Pass | `relay/test/envelope-and-rooms.test.ts`、`http-server.test.ts`、`browser-e2e.mjs` |
| TC-012   | `eventSeq` の順序                              | 同じ Room に、複数のイベントを受理させる                                                                                             | `eventSeq` が、一意で増加する。                                                                                    | TR-012         | `eventSeq` の一意・単調増加を確認                | Pass | `relay/test/events.test.ts`                                                      |
| TC-013   | 他の端末がオフラインの場合                     | 同じ Room で、端末 X をオンライン、端末 Y をオフラインにする。`targetId` を X として IF-006 を呼ぶ。後で Y が再接続し、IF-001 を呼ぶ | IF-006 は拒否されない。Y は、再接続時の IF-001 で最新の `controlSeq` を取得する。                                  | TR-013         | X 指定の更新成功と Y 接続時 Pull を確認          | Pass | `relay/test/control.test.ts`、`demo/test/protocol-e2e.test.ts`                   |

### 4.2 DD の機能テスト要件（`core`、サーバー、`storage-indexeddb`）

| ケースID | 対象・条件                        | 入力・操作                                                                                    | 期待結果                                                                                                                                  | 期待結果の根拠 | 実績結果                                        | 判定 | 証跡                                                                             |
| :------- | :-------------------------------- | :-------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------- | :------------- | :---------------------------------------------- | :--- | :------------------------------------------------------------------------------- |
| TC-101   | Domain Store の決定論性と復元     | 同じ初期状態と同じイベント列を適用する。ストアを閉じて開き直し、復元する                      | 同じ状態が得られる。開き直した後も、イベントログから同じ状態を復元できる。                                                                | TR-101         | メモリ / Fake IDB / 実 Chrome IDB で復元を確認  | Pass | `core/test/domain-store.test.ts`、`indexeddb-storage.test.ts`、`browser-e2e.mjs` |
| TC-102   | 追記の失敗                        | `StoragePort` の追記が失敗する状況で、イベントを適用する                                      | 状態は更新されない。                                                                                                                      | TR-102         | 失敗時に状態が不変であることを確認              | Pass | `core/test/domain-store.test.ts`、`storage-indexeddb/test/indexeddb-storage.test.ts` |
| TC-103   | `sendFilter` の mode              | `NONE`、`ALL`、`TYPES` の各々で、評価する                                                     | `NONE` は何も送らない。`ALL` はすべて。`TYPES` は `payload.type` が一致するものだけ。                                                     | TR-103         | 各 mode のフィルタリング結果を確認              | Pass | `core/test/outbox.test.ts`、`browser-e2e.mjs`                                    |
| TC-104   | `targetIds` と不正な `sendFilter` | `targetIds` に含まれない端末で評価する。`TYPES` で `types` が空のフィルタで評価する           | 含まれない端末は何も送らない。不正なフィルタは `NONE` と同じ扱い。                                                                        | TR-104         | `targetIds` 除外と空 `TYPES` 抑止を確認         | Pass | `core/test/outbox.test.ts`                                                       |
| TC-105   | 接続時の手順                      | 接続を開く（初回、自動再接続）                                                                | IF-001 が完了してから IF-002 が実行される。                                                                                               | TR-105         | 初回・再接続とも IF-001 → IF-002 順序を確認     | Pass | `core/test/sync-engine.test.ts`、`browser-e2e.mjs`                               |
| TC-106   | `STALE_CONTROL_SEQ` 後の再評価    | IF-002 が `STALE_CONTROL_SEQ` で拒否される状況を作る                                          | イベントは破棄されず、IF-001 の後に、新しいフィルタで再評価される。                                                                       | TR-106         | 未破棄のまま再 Pull 後に再送信されることを確認  | Pass | `core/test/sync-engine.test.ts`                                                  |
| TC-107   | 通信エラーの再試行                | 通信エラーを V-06 の回数を超えて起こす                                                        | 同じ `requestId` で V-06 の回数まで、V-07 の待ち時間で再試行され、上限で `Stopped` になる。                                               | TR-107         | 同一 `requestId`・指数バックオフ・停止を確認    | Pass | `core/test/sync-engine.test.ts`                                                  |
| TC-108   | `SCHEMA_VERSION_MISMATCH` の受信  | サーバーが `SCHEMA_VERSION_MISMATCH` を返す                                                   | 再試行せずに `Stopped` になる。永続状態は変化しない。                                                                                     | TR-108         | 再試行なし停止・永続状態不変を確認              | Pass | `core/test/sync-engine.test.ts`、`demo/test/protocol-e2e.test.ts`                |
| TC-109   | presence heartbeat の送信         | 接続し、V-04 の間隔を超えて待つ。`disconnect` する                                            | V-04 の間隔で送られる。`disconnect` で止まる。                                                                                            | TR-109         | 5 秒周期送信と `disconnect` 停止を確認          | Pass | `core/test/sync-engine.test.ts`                                                  |
| TC-110   | `controlSeq` と `eventSeq` の採番 | 同じ Room で、制御状態の変更とイベントの送信を繰り返す。同じ `eventId` を再送する             | どちらも、一意に増加する。同じ `eventId` は二重に追加されない。                                                                           | TR-110         | 単調増加と冪等性を確認                          | Pass | `relay/test/events.test.ts`                                                      |
| TC-111   | lease の状態遷移                  | DD §3.2 の lease の遷移表の各行の操作を行う                                                   | 表のとおりに、`controlSeq` が発行され、通知される。`RENEW` では発行も通知もされない。                                                     | TR-111         | 全遷移ケースで発行・通知有無を確認              | Pass | `relay/test/lease.test.ts`                                                       |
| TC-112   | lease の期限での解放              | 期限の時刻の直後に、アクセスせずに、通知を確認する                                            | 期限の時刻に解放され、`controlSeq` が発行され、通知される（次のアクセスを待たない）。                                                     | TR-112         | タイマーでの自動解放と通知を確認                | Pass | `relay/test/lease.test.ts`、`http-server.test.ts`、`protocol-e2e.test.ts`、`browser-e2e.mjs` |
| TC-113   | オンライン判定                    | 接続がない、presence の期限切れ、接続と presence の両方が有効、の各端末を用意する             | 接続がない、または期限切れの端末はオフライン。他の端末の状態に影響されない。                                                              | TR-113         | SSE + presence 両立判定と端末独立性を確認       | Pass | `relay/test/control.test.ts`、`demo/test/protocol-e2e.test.ts`                   |
| TC-114   | 共通項目の検証                    | 共通項目の欠落、不一致のリクエストを送る                                                      | 欠落は `INVALID_MESSAGE`、不一致は `SCHEMA_VERSION_MISMATCH`。他の機能は呼び出されない。                                                  | TR-114         | 400 エラーと状態不変を確認                      | Pass | `relay/test/envelope-and-rooms.test.ts`                                          |
| TC-115   | `requestId` の再送                | 同じ `requestId` の IF-006 を、V-08 の期間内に再送する                                        | 二重に適用されず、最初の応答と同じ `controlSeq` が返される。                                                                              | TR-115         | 10 分保持期間内の同一 `controlSeq` 返却を確認   | Pass | `relay/test/control.test.ts`                                                     |
| TC-116   | 制御状態の反映                    | 制御状態を反映する。保持している値より小さい `controlSeq` の応答を反映しようとする            | Domain Store の状態は変化しない。保持する `controlSeq` は最新値と一致し、小さい値は反映されない。                                         | TR-116         | 古い値拒否（`false`）とドメイン不変を確認       | Pass | `core/test/control-store.test.ts`                                                |
| TC-117   | Room ごとの読み出し               | 2つの Room に、未送信のイベントを追記する。Room A の送信対象を評価する                        | Room A のイベントだけが読み出され、送信対象になる。Room B のイベントは、読み出されず、送信されない。                                      | TR-117         | Room A 限定の読み出し・送信を確認               | Pass | `core/test/outbox.test.ts`、`storage-indexeddb/test/indexeddb-storage.test.ts`   |
| TC-118   | ロック検証とオフライン判定の順序  | 保持者でない操作者、保持者でオフラインの端末、保持者でオンラインの端末の各々で、IF-006 を呼ぶ | 順に `LOCK_NOT_HELD`、`TARGET_OFFLINE`、成功。拒否の場合は、`controlSeq` が発行されず、制御状態は変わらない。                             | TR-118         | 判定順序と拒否時不変を確認                      | Pass | `relay/test/control.test.ts`                                                     |
| TC-119   | `CONTROL_UPDATED` 後の再評価      | 接続中に `CONTROL_UPDATED` を通知する                                                         | IF-001 で制御状態を取得し直し、未送信イベントが新しい `sendFilter` で再評価される。                                                       | TR-119         | SSE 通知トリガーの Pull と再評価を確認          | Pass | `core/test/sync-engine.test.ts`、`browser-e2e.mjs`                               |
| TC-120   | `STALE_CONTROL_SEQ` の連続        | `STALE_CONTROL_SEQ` を V-11 の回数を超えて返す。その後、Push を受理させる                     | V-11 の回数まで再評価される。超えたら通信エラー1回として数える。受理で、連続回数と失敗の回数が 0 に戻る。V-06 の上限で `Stopped` になる。 | TR-120         | V-11 上限・0 リセット・V-06 停止を確認          | Pass | `core/test/sync-engine.test.ts`                                                  |
| TC-121   | 二重追記（DomainStore）           | 同じ `eventId` のイベントを、`DomainStore.apply` で2回追記する                                | エラーにならず、2回目は追記済みとして扱われる。状態は二重に更新されず、現在の状態が返る。                                                 | TR-121         | 冪等適用と現在状態返却を確認                    | Pass | `core/test/domain-store.test.ts`、`indexeddb-storage.test.ts`                    |
| TC-122   | `createdAt` の既定値              | `createdAt` を省略して追記する。指定して追記する                                              | 省略した場合は、追記時の時刻が設定される。指定した場合は、その値が使われる。                                                              | TR-122         | 省略時 `now()`・指定値優先を確認                | Pass | `core/test/domain-store.test.ts`                                                 |
| TC-123   | `controlSeq` の不正な値           | `ControlStore.applyControl` に、NaN、負の値、小数、無限大を渡す                               | `RangeError` になり、状態は変更されない。その後も、古い応答は反映されない。                                                               | TR-123         | `RangeError` 送出と状態不変を確認               | Pass | `core/test/control-store.test.ts`                                                |

### 4.3 データ構造（DS）と非機能要件の確認

| ケースID | 対象・条件                             | 入力・操作                                                        | 期待結果                                                                                                                                                    | 期待結果の根拠                | 実績結果                                            | 判定 | 証跡                                                               |
| :------- | :------------------------------------- | :---------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------- | :-------------------------------------------------- | :--- | :----------------------------------------------------------------- |
| TC-201   | 追記の原子性（IndexedDB）              | `events` と `delivery` の追記の途中で、トランザクションを中断する | どちらも保存されない。`events` にあって `delivery` にない状態にならない。                                                                                   | DS §3.1                       | 途中中断時に両ストアとも 0 件であることを確認       | Pass | `storage-indexeddb/test/indexeddb-storage.test.ts`                 |
| TC-202   | 同じ `eventId` の二重追記（IndexedDB） | 同じ `eventId` を2回追記する                                      | 2回目は IndexedDB の `ConstraintError` で拒否され、アダプターが `DuplicateEventError` に変換して投げる。呼び出し元（`DomainStore`）は、追記済みとして扱う。 | DS §3.2                       | `DuplicateEventError` 変換と冪等適用を確認          | Pass | `storage-indexeddb/test/indexeddb-storage.test.ts`                 |
| TC-203   | 新しい保存形式の版の検出               | `meta.storageVersion` が `"1"` より新しいデータベースを開く       | エラー停止する。データは変更されず、親へ通知される。                                                                                                        | DS §4.1、要件定義書 NFR-03    | Fake IDB / 実 Chrome IDB 双方で停止・データ保全確認 | Pass | `indexeddb-storage.test.ts`、`browser-e2e.mjs`                     |
| TC-204   | `strict: true` の型検査                | 各パッケージを型検査する                                          | エラー 0 件。`tsconfig` で `strict: true` が有効。                                                                                                          | 要件定義書 NFR-01、ENV QG-002 | 全ワークスペースで `tsc --noEmit` エラー 0 件       | Pass | `tsconfig.base.json`、`TypeScript CI` (`46146236691`)              |
| TC-205   | `core` の依存の有無                    | `core` の `package.json` の `dependencies` を確認する             | `dependencies` が空である。                                                                                                                                 | 要件定義書 CN-02、ENV §5      | `packages/core/package.json` に `dependencies` なし | Pass | `packages/core/package.json`、`submodule-integration.mjs`          |

### 4.4 `transport-http` の契約テスト

| ケースID | 対象・条件                             | 入力・操作                                                                                  | 期待結果                                                                                                               | 期待結果の根拠            | 実績結果                                      | 判定 | 証跡                                       |
| :------- | :------------------------------------- | :------------------------------------------------------------------------------------------ | :--------------------------------------------------------------------------------------------------------------------- | :------------------------ | :-------------------------------------------- | :--- | :----------------------------------------- |
| TC-301   | HTTP/SSE リクエストと共通項目          | IF-001〜IF-004 を実行する                                                                   | HTTP は `X-Schema-Version`・`X-Request-Id` ヘッダー、SSE はクエリパラメータに載る。                                    | IF §2.2、§4.1〜§4.4       | ヘッダー / クエリ付与を確認                   | Pass | `transport-http/test/http-transport.test.ts` |
| TC-302   | 既定 `fetch` の呼び出し                | `options.fetch` を省略して `fetchControl` を呼ぶ                                            | グローバル `fetch` が `this` 束縛なしで呼ばれ、`Illegal invocation` にならない。                                       | ENV §2、BD C-010          | ラップ呼び出しと実ブラウザでの正常動作を確認  | Pass | `http-transport.test.ts`、`browser-e2e.mjs`  |
| TC-303   | 2xx 不正応答・信頼境界の検証           | 不正な JSON、またはスキーマ外の `ControlSnapshot` / `accepted` を返す                       | `INVALID_RESPONSE` の `TransportError` が投げられる。                                                                  | DD §4.1、IF §4.1・§4.2    | `INVALID_RESPONSE` 検出を確認                 | Pass | `transport-http/test/http-transport.test.ts` |
| TC-304   | 通信・本文読込・タイムアウト・5xx      | 通信失敗、`response.text()` の拒否・遅延、HTTP 5xx を発生させる                            | `code` なしの `TransportError`（再試行可）になる。本文読み込み中もタイムアウト（V-05）が効く。                         | DD V-05、§4.1             | `code` なしエラーと `AbortController` を確認  | Pass | `transport-http/test/http-transport.test.ts` |
| TC-305   | 4xx エラー応答の変換                   | 共通エラー形式（`STALE_CONTROL_SEQ` 等）、未知コード JSON、非 JSON の 4xx を返す            | 既知コードは `code`（と `controlSeq`）を引き継ぐ。未知コード・非 JSON は `HTTP_<status>` になる。                      | IF §2.2、DD §4.1          | 既知/未知コード・非 JSON の変換を確認         | Pass | `transport-http/test/http-transport.test.ts` |
| TC-306   | SSE 通知の `schemaVersion` 検証        | 一致する通知、欠落・不正形式の通知、不一致の `schemaVersion` の通知を受信する               | 一致する通知のみ中継し、欠落・不正は無視する。不一致は接続を閉じて `SCHEMA_VERSION_MISMATCH` を通知する。               | IF §4.3.2、§5、REQ NFR-03 | 中継・無視・切断通知の各動作を確認            | Pass | `transport-http/test/http-transport.test.ts` |
| TC-307   | SSE の切断検知と `close()`             | `onerror`（`readyState` が `0` と `2`）と `close()` を呼ぶ                                  | `readyState === 2` のみ `closed: true` を返し、`close()` は内部 `EventSource` を閉じる。                               | IF §4.3.3                 | `readyState` 判定と `close()` 委譲を確認      | Pass | `transport-http/test/http-transport.test.ts` |

## 5. 実施結果

`develop` ブランチ最新コミット（`3586ae4`）に対する GitHub Actions 上での自動検証結果を記録します。

| 実行ID                                                                                       | 実行日     | 実行者・実行環境                  | 実行方法                                               | 結果概要                                                      | 証跡                                                                                 |
| :------------------------------------------------------------------------------------------- | :--------- | :-------------------------------- | :----------------------------------------------------- | :------------------------------------------------------------ | :----------------------------------------------------------------------------------- |
| `46146236691`                                                                                | 2026-11-28 | GitHub Actions (`ubuntu-latest`)  | `TypeScript CI` (`lint` / `typecheck` / `test` / `build`) | **Pass**（14 テストファイル / 131 テスト全合格、エラー 0 件） | [TypeScript CI Run 46146236691](https://github.com/xzyozi/control-sync-ui/actions/runs/46146236691) |
| `46146236648`                                                                                | 2026-11-28 | GitHub Actions (`ubuntu-latest`)  | `Browser E2E` (`browser-e2e.mjs` + `submodule-integration.mjs`) | **Pass**（Chrome E2E 全観点合格、workspaces/`file:` 統合合格） | [Browser E2E Run 46146236648](https://github.com/xzyozi/control-sync-ui/actions/runs/46146236648) |

- **総合判定**: **合格（Pass）**。
- **判定理由**: TC-001〜TC-013、TC-101〜TC-123、TC-201〜TC-205、TC-301〜TC-307 のすべてが自動テストおよび実ブラウザ E2E で Pass し、品質ゲート QG-001〜QG-006 を満たしている。

## 6. 未実施・対象外・テスト差異

| ID     | 対象項目                                        | 状態     | 理由・標準との差異                                                                                 | 影響・リスク                                                   | 代替確認・対応                                                                 | 承認者・期限 |
| :----- | :---------------------------------------------- | :------- | :------------------------------------------------------------------------------------------------- | :------------------------------------------------------------- | :----------------------------------------------------------------------------- | :----------- |
| EX-001 | 全ケース                                        | 解消済み | 実装完了に伴い、全ケースを実施した。                                                               | なし。                                                         | GitHub Actions にて全自動テストを実施し、§5 に証跡を記録済み。                 | 2026-11-28   |
| EX-002 | IndexedDB と EventSource のブラウザでの検証範囲 | 部分的   | CI の実ブラウザ E2E は `ubuntu-latest` 上の Google Chrome のみで実行（Firefox / Safari は未検証）。 | Chrome 以外のブラウザ固有の IndexedDB / EventSource 挙動の差異。 | `storage-indexeddb`・`transport-http` の単体テストと Chrome E2E で基本契約を担保。 | v0.1 時点    |
| EX-003 | 要件 FR-01〜FR-05 の受け入れ条件との直接の対応  | 解消済み | `browser-e2e.mjs` および `protocol-e2e.test.ts` で FR-01〜FR-05 全体を直接シナリオ検証した。        | なし。                                                         | PR #31 以降、FR-01〜FR-05 の E2E シナリオを CI で継続検証。                   | 2026-11-28   |

## 7. 関連文書

- **要求・機能仕様**: [CSU-REQ-001](../features/CSU-REQ-001_最小要件定義書.md)
- **基本・詳細・データ構造設計**: [CSU-BD-001](../design/CSU-BD-001_基本設計書.md)、[CSU-IF-001](../design/CSU-IF-001_IF仕様書.md)、[CSU-DD-001](../design/CSU-DD-001_詳細設計書.md)、[CSU-DS-001](../design/CSU-DS-001_データ構造仕様書.md)
- **環境・運用手順**: [CSU-ENV-001](../setup/CSU-ENV-001_環境・開発基盤仕様書.md)

## 8. 作成完了チェック

- [x] `document_role`、`ssot_scope`、`status`、`owner`をFrontmatterへ設定した。
- [x] 目的、対象範囲、対象外、関連する要求・設計を記入した。
- [x] 採用したテスト戦略と、合格基準を記入した。
- [x] TDD を採用するため、対象 Seam を記入した。Red→Green の記録は、実装の進行に合わせて追加する。
- [x] テストケースに期待結果、根拠、判定を記入した。実績と証跡は、実施後に記入する。
- [x] 機能テスト要件を検証するケースの根拠に、要件 ID を記載した。
- [x] 品質ゲートは環境・開発基盤仕様書を参照し、実行コマンドや合格基準を再掲していない。
- [x] 未実施・対象外・標準からの差異の理由と影響を記録した。
- [x] テスト文書が要求・設計の正本を上書きしていないことを確認した。
- [x] 秘密情報そのものや利用者固有の認証情報を記載していない。

## 9. 改訂履歴 (Change Log)

| 版数    | 改訂日     | 変更者 | 変更内容・変更理由 (Why)                                                                                                   |
| :------ | :--------- | :----- | :------------------------------------------------------------------------------------------------------------------------- |
| Rev.0.1 | 2026-11-28 | xzyozi | 新規作成。TR-001〜013、TR-101〜120 に対応するケース（TC-001〜013、TC-101〜120）と、DS・非機能の確認（TC-201〜205）を定義。 |
| Rev.0.2 | 2026-11-28 | xzyozi | レビュー指摘（#25）を反映し、§1 のテスト対象に `transport-http` を追加、§4.4 に `TC-301〜TC-307` を定義。 |
| Rev.0.3 | 2026-11-28 | xzyozi | v0.1 MVP 実装完了に伴い、TC-001〜TC-307 の実績結果・判定・証跡（`TypeScript CI` / `Browser E2E`）を記録し、status を `approved` へ更新。 |
