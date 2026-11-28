---
title: "環境・開発基盤仕様書"
document_type: "environment_specification"
document_number: "CSU-ENV-001"
document_role: "normative"
ssot_scope: "environment"
status: "approved"
version: "1.10"
created_at: "2026-11-28"
updated_at: "2026-11-28"
author: "xzyozi"
owner: "xzyozi"
purpose: "状態同期基盤（v0.1 MVP）の開発・検証環境について、変更できない条件と、品質ゲートの実行条件・合格基準を定義するため"
related_documents:
  - "ドキュメントガバナンス（相対パス: ../README.md）"
  - "TypeScript プロジェクト環境構築手順書（相対パス: ./typescript_setup.md）"
  - "依存管理（相対パス: ./dependency_management.md）"
  - "ドキュメント検証（相対パス: ./doc_validation.md）"
  - "Mermaid CI 検証（相対パス: ./mermaid_ci_validation.md）"
  - "CSU-BD-001 基本設計書（相対パス: ../design/CSU-BD-001_基本設計書.md）"
  - "CSU-DD-001 詳細設計書（相対パス: ../design/CSU-DD-001_詳細設計書.md）"
---

# 環境・開発基盤仕様書
**状態同期基盤 v0.1 MVP：TypeScript（`strict: true`）の開発・検証環境と品質ゲート**

---

## 1. 目的・対象範囲

- **目的**: 実装の合否を、同じ基準で判定できるようにする。BD と DD が参照する品質ゲートの、実行条件と合格基準を定める。
- **対象環境**: ローカルの開発環境と、GitHub Actions の CI。
- **対象範囲**: `core`、`storage-indexeddb`、`transport-http`、`relay`、`demo` の5パッケージ（BD §2.2）と、`docs/` 配下の文書。
- **対象外**: 本番環境、公開の手順、親プロジェクト側の環境。

## 2. ハード要件・制約

- **必須プラットフォーム**: 特定の OS を要求しない。ローカルは macOS、Linux、Windows。CI は `ubuntu-latest`。
- **互換性・契約**: `core` は、ブラウザ API とランタイムに依存しない（Zero-Dependency Core、CN-02）。`core` の単体検証は、ブラウザなしの Node で行える。
- **サブモジュール**: 親プロジェクトに Git サブモジュールとして組み込まれる（要件定義書 §1）。親のバンドラ（Vite、Webpack、esbuild）に依存しない。
- **ネットワーク・アクセス制約**: パッケージの取得に、インターネットへの接続が必要。
- **その他の制約**: パッケージマネージャーは npm または pnpm を使う（yarn は、公開直後のパッケージを避ける機能がないため使わない）。

## 3. 環境概要

| 環境         | 用途                         | プラットフォーム / 実行方式       | 所有者 | 更新・廃止方針                              |
| :----------- | :--------------------------- | :-------------------------------- | :----- | :------------------------------------------ |
| ローカル開発 | 実装、単体テスト、文書の検証 | 開発者の端末。Node.js 20.x 以上。 | 開発者 | Node.js は、LTS の更新に合わせる。          |
| CI           | 品質ゲートの自動実行         | GitHub Actions（`ubuntu-latest`） | owner  | ワークフローの変更は、PR のレビューを経る。 |

## 4. 適用する環境要素

### 4.1 言語・ランタイム・実行基盤

- **言語**: TypeScript。`tsconfig` で `strict: true` を有効にする（NFR-01）。
- **ランタイム**: Node.js 20.x 以上。この版は本書を正本とし、[TypeScript 環境構築手順書](./typescript_setup.md) は、本書の版に従う。CI の TypeScript は、最新の LTS を使う。Mermaid の検証は、Node.js 22.14.0 に固定する。
- **ブラウザ**: `storage-indexeddb` と `demo` の動作確認に、IndexedDB と EventSource を使えるブラウザが必要。対象の版は、実装時に決める。

### 4.2 ツールチェーン・依存関係

- **ツール**: Biome（lint。書式の検査は現在無効で、§4.4 を参照）、TypeScript（型検査とビルド）、Vitest（単体テスト）。雛形は `templates/typescript/` に従う（[手順書](./typescript_setup.md)）。
- **依存管理**: [依存管理](./dependency_management.md) に従う。`package-lock.json` は、必ず Git の追跡対象にする（CI の `npm ci` に必須）。この規則は本書を正本とし、手順書は本書を参照する。
- **`core` の依存**: ランタイムの依存パッケージを持たない。開発用の依存（`devDependencies`）だけを許可する。また、`tsconfig.base.json` の `lib` に DOM を含めないため、`core` が DOM に依存すると、型検査（QG-002）で失敗する。

### 4.3 ビルド・パッケージング・配布

- **成果物**: 各パッケージの `npm run build` が、`dist/` に ESM（`.js` 拡張子付きの相対インポート）と型定義（`.d.ts`）を出力する。`dist/` は Git に含めない（[ADR-008](../adr/ADR-008_サブモジュールとしての消費方式.md)）。
- **パッケージ契約**: `core`・`storage-indexeddb`・`transport-http`・`relay` は `package.json` で `exports`（`.` の `types` / `import` / `default`）・`sideEffects: false`・`engines`（`node >= 20`）を公開する。内部のパッケージ間依存は `file:../core` を用い、`file:` 参照時にも公開レジストリへ解決を試みない。
- **配布・組み込み**: 親プロジェクトへは Git サブモジュールで組み込む。親はサブモジュール内で `npm ci && npm run build` を実行したうえで、**npm workspaces 併用**または **`file:` 依存**で各パッケージを参照する。具体的な手順は [サブモジュール統合手順書](../how-to/submodule_integration.md) を正本とする。npm レジストリへの公開は、v0.1 の対象外。
- **版の管理方針（リリース・タグ・互換性・破壊的変更）**:
  - **Git タグとリリース版**: リリース時は [リリース運用手順書](../how-to/release_branch_operation.md) に従い `main` へ反映したうえで `v<MAJOR>.<MINOR>.<PATCH>`（例: `v0.1.0`）のタグを付与する。ワークスペース内の `@csu/*` 各パッケージの `package.json` の `version` は同一値に揃える。親プロジェクトは原則としてリリース済みタグへピン留めして利用する。
  - **破壊的変更の扱い**: 公開 API（`exports`・`StoragePort` / `TransportPort` 契約）・通信プロトコル・永続化スキーマのいずれかに破壊的変更を加える場合は、設計正本（IF / DD / DS / ENV）および必要な ADR を先に更新し、`0.x` 系では `MINOR`（`1.0.0` 以降は `MAJOR`）を上げて移行手順を明記する。
  - **`schemaVersion`（通信契約）の互換性**: v0.1 では `"1"` の厳格一致とし、不一致時は状態を変更せず `SCHEMA_VERSION_MISMATCH` で安全停止する（[IF §5](../design/CSU-IF-001_IF仕様書.md)、[DD §2.3](../design/CSU-DD-001_詳細設計書.md)）。非互換なメッセージ変更時は `schemaVersion` を更新し、互換変換（アップキャスター等）は #7 で扱う。
  - **`storageVersion`（永続化形式）の互換性**: v0.1 では `STORAGE_VERSION = "1"` / `DB_SCHEMA_VERSION = 1` とし、上位版・不一致時はデータを変更せず `UnsupportedStorageVersionError` で安全停止する（[DS §4.1](../design/CSU-DS-001_データ構造仕様書.md)）。移行導入時は DS §4.1 の移行表を先に更新する。

### 4.4 CI/CD・品質ゲート

CI は、`main` と `develop` への `push` と `pull_request` で実行する。品質ゲートは、次の表を正本とする。設計書とテスト文書は、ゲート ID で参照する。

| ゲートID | 検証種別         | 実行コマンドまたはワークフロー                                                                | 適用条件                                                               | 合格基準                                   |
| :------- | :--------------- | :-------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------- | :----------------------------------------- |
| QG-001   | 静的解析（lint） | `npm run lint`（ワークフロー: `ci-typescript.yml`）                                           | ルートに `package.json` があるとき。TypeScript のソースを変更する PR。 | 指摘 0 件。                                |
| QG-002   | 型検査           | `npm run typecheck`（ワークフロー: `ci-typescript.yml`）                                      | QG-001 と同じ。                                                        | 型エラー 0 件。`strict: true` であること。 |
| QG-003   | 単体テスト       | `npm test`（ワークフロー: `ci-typescript.yml`）                                               | QG-001 と同じ。テストが存在するとき。                                  | すべてのテストが合格する。                 |
| QG-004   | ビルド           | `npm run build`（ワークフロー: `ci-typescript.yml`）                                          | QG-001 と同じ。                                                        | 各パッケージの `dist/` が出力される。      |
| QG-005   | 文書検証         | `python .github/scripts/validate_docs.py docs README.md`（ワークフロー: `validate-docs.yml`） | `docs/` または `README.md` を変更する PR。                             | エラー 0 件。警告は、PR に記載する。       |
| QG-006   | Mermaid 図の検証 | `node .github/scripts/validateMermaidMarkdown.mjs`（ワークフロー: `validate-mermaid.yml`）    | `docs/` 配下の Markdown を変更する PR。                                | すべての図が描画できる。                   |
| QG-007   | レビュー         | PR のレビュー（人手）                                                                         | すべての PR。                                                          | 指摘への対応が済み、承認されている。       |

- ルートに `package.json` があるため、QG-001〜QG-004 は有効である（`ci-typescript.yml` の仕様）。
- **パッケージの構成**（[要件定義書](../features/CSU-REQ-001_最小要件定義書.md) の OP-11、OP-08）: npm ワークスペース（`packages/*`）で構成する。パッケージは、`core`、`storage-indexeddb`、`transport-http`、`relay`、`demo` の5つで、実装する時点で追加する。ルートに共通設定（`biome.json`、`tsconfig.base.json`、`vitest.config.ts`）を置き、各パッケージが `typecheck` と `build` のスクリプトを持つ。
- **QG-001 の範囲**: 現在の Biome の設定は、lint だけを有効にし、書式（フォーマット）の検査は行わない。検査の対象は、`packages/` とルートの `vitest.config.ts` に限る。`.github/scripts/` の既存の検証スクリプト（`validateMermaidMarkdown.mjs` など）は、それぞれのワークフロー（QG-005、QG-006）の対象であり、QG-001 の対象外とする。書式の検査は、実装が増えた段階で追加を検討する。
- **QG-003 の範囲**: 単体・結合テストは `packages/*/test/**/*.test.ts` を、Node の環境で実行する。ブラウザ固有の API（IndexedDB、EventSource）およびダミー親リポジトリによるサブモジュール統合は、`e2e.yml`（Google Chrome / Playwright）で自動検証する（[CSU-TEST-001](../test/CSU-TEST-001_テスト計画・結果報告書.md)）。
- **`package-lock.json`**: プロジェクトルートの `package-lock.json` を Git で追跡し、CI は `npm ci` および `setup-node` の npm キャッシュを使用する（`ci-typescript.yml`、`e2e.yml`）。ローカルに Node がない環境でロックファイルを再生成する必要がある場合は、CI の `--before` 設定と同等の 3 日猶予ルール（§4.6）に従う。

### 4.5 設定・秘密情報

- 認証トークンは `HttpTransportOptions.authToken`（同期/非同期プロバイダ）およびサーバー側 `RelayHttpOptions.authenticate` 経由で外部から注入し、リポジトリ内へ固定値を書き込まない（#8）。
- `.env` などの秘密情報を含むファイルは、`.gitignore` に追加する。監査フック（`onAudit`）および標準エラーログに秘密情報・トークン・`payload` 本文を出力しない。

### 4.6 再現性・サプライチェーン

- **依存の固定**: `package-lock.json` を追跡し、CI は `npm ci` で、ロックファイルのとおりに導入する。
- **公開直後のパッケージ**: ローカルの開発環境では、パッケージマネージャーに、公開から一定期間（npm の `min-release-age=3`、pnpm の `minimumReleaseAge=4320`）を待つ設定をする。ロックファイルを再生成・更新する場合も、同じ趣旨で `npm install` に `--before`（3日前の時点）を付け、公開から3日以内の版を固定しない。
- **CI のブラウザ**: Mermaid の検証に必要な Chrome は、バージョンを固定してインストールする（`validate-mermaid.yml`）。

## 5. 検証方法

| 確認項目                | 確認方法                                                | 合格条件                         | 証跡                        |
| :---------------------- | :------------------------------------------------------ | :------------------------------- | :-------------------------- |
| 品質ゲートの実行        | PR で、QG-001〜QG-006 の CI が実行される。              | 該当するゲートがすべて成功する。 | GitHub Actions の実行結果。 |
| `core` の依存の有無     | `core` の `package.json` の `dependencies` を確認する。 | `dependencies` が空である。      | PR の差分。                 |
| `strict: true` の有効化 | `tsconfig` を確認する。                                 | `strict` が `true` である。      | PR の差分。                 |

## 6. 例外・適用差異

| ID     | 対象                                        | 標準との差異                                                                       | 理由・制約                                             | 影響                                                                     | 代替対応                                                                        | 解除条件                                                                                                                 |
| :----- | :------------------------------------------ | :--------------------------------------------------------------------------------- | :----------------------------------------------------- | :----------------------------------------------------------------------- | :------------------------------------------------------------------------------ | :----------------------------------------------------------------------------------------------------------------------- |
| EX-001 | QG-001〜QG-004（実装がない期間）            | `package.json` がないため、CI がスキップされる。                                   | 実装の前の段階で、検証の対象がない。                   | 実装の品質を、まだ CI で確認できない。                                   | 文書の検証（QG-005、QG-006）のみ。                                              | **解除済み**（2026-11-28）。ルートに `package.json` を追加した。                                                         |
| EX-002 | 依存の固定（`package-lock.json`、`npm ci`） | ロックファイルがないため、CI は `npm ci` ではなく `npm install` で依存を導入する。 | ローカルに Node がなく、ロックファイルを生成できない。 | 依存の版が、実行のたびに変わりうる（サプライチェーンの固定ができない）。 | 手動実行のワークフロー `generate-lockfile.yml` で生成し、成果物をコミットする。 | **解除済み**（2026-11-28）。`package-lock.json` をコミットし、`generate-lockfile.yml` を削除した。 |

## 7. 関連文書

- **構築・統合手順**: [TypeScript プロジェクト環境構築手順書](./typescript_setup.md)、[依存管理](./dependency_management.md)、[サブモジュール統合手順書](../how-to/submodule_integration.md)
- **設計書・ADR**: [BD](../design/CSU-BD-001_基本設計書.md)、[DD](../design/CSU-DD-001_詳細設計書.md)、[DS](../design/CSU-DS-001_データ構造仕様書.md)、[IF](../design/CSU-IF-001_IF仕様書.md)、[ADR-008](../adr/ADR-008_サブモジュールとしての消費方式.md)
- **運用・テスト**: [CSU-TEST-001 テスト計画・結果報告書](../test/CSU-TEST-001_テスト計画・結果報告書.md)

## 8. 作成完了チェック

- [x] `document_role`、`ssot_scope`、`status`、`owner`をFrontmatterへ設定した。
- [x] 目的、対象範囲、対象外、ハード要件・制約を記載した。
- [x] 必要な環境要素だけを選択し、不要な項目を無理に追加していない。
- [x] 品質ゲートのゲートID・実行方法・適用条件・合格基準を4.4に記載した。
- [x] 検証方法と合格条件を記載した。
- [x] 標準から外れる場合（実装がない期間）は、理由・影響・代替対応・解除条件を記録した。
- [x] セットアップ手順書、設計書への参照を設定した。テスト文書（CSU-TEST-001）への参照も設定した。
- [x] 秘密情報や利用者固有の認証情報を記載していない。

## 9. 改訂履歴 (Change Log)

| 版数    | 改訂日     | 変更者 | 変更内容・変更理由 (Why)                                                                                                                                                                                                                                                        |
| :------ | :--------- | :----- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Rev.1.0 | 2026-11-28 | xzyozi | 新規作成（初版制定）。BD と DD が参照する品質ゲート（QG-001〜QG-007）の実行条件と合格基準を定義。                                                                                                                                                                               |
| Rev.1.1 | 2026-11-28 | xzyozi | パッケージ構成を要件定義書 OP-11 で管理することを明記。テスト計画・結果報告書（CSU-TEST-001）への参照を追加。                                                                                                                                                                   |
| Rev.1.2 | 2026-11-28 | xzyozi | npm ワークスペースの構成（OP-11）と `transport-http`（OP-08）を反映。ルートに `package.json` を追加したため、EX-001 を解除。QG-001（lint のみ）、QG-003、`package-lock.json` の扱いを明記。                                                                                     |
| Rev.1.3 | 2026-11-28 | xzyozi | CI 失敗（`setup-node` の `cache: npm` がロックファイルなしで失敗）への対応。`ci-typescript.yml` のキャッシュをロックファイルがあるときだけ有効にし、ロックファイル生成用の手動ワークフローを追加。期限つきの例外 EX-002 を登録。§4.2 の Biome の記述を実態（lint のみ）に修正。 |
| Rev.1.4 | 2026-11-28 | xzyozi | CI の lint（QG-001）が、既存の `.github/scripts/validateMermaidMarkdown.mjs` の `noForEach` で失敗したため、Biome の検査対象を `packages/` とルートの `vitest.config.ts` に限定し、QG-001 の範囲として明記。                                                                    |
| Rev.1.5 | 2026-11-28 | xzyozi | ロックファイル生成ワークフローに、公開から3日以内の版を固定しない設定（`--before`）を追加し、§4.6 に明記。                                                                                                                                                                      |
| Rev.1.6 | 2026-11-28 | xzyozi | `package-lock.json` をルートにコミットし、`generate-lockfile.yml` を削除して例外 EX-002 を解除。                                                                                                                                                                                |
| Rev.1.7 | 2026-11-28 | xzyozi | ADR-008（`accepted`）の決定を §4.3 へ反映し、`exports`・`types`・`sideEffects`・`engines`・ワークスペース/`file:` 両対応および統合手順書への参照を追加。                                                                                                                          |
| Rev.1.10 | 2026-11-28 | xzyozi | #8 対応として §4.5 に認証トークンの注入方針（`authToken` / `authenticate`）と監査ログの秘密情報非出力を追記。 |
| Rev.1.8 | 2026-11-28 | xzyozi | §4.3 に版の方針（Git タグ `vX.Y.Z`、破壊的変更時の版上げ、`schemaVersion` / `storageVersion` の互換性範囲）を追加。                                                                                                                                                              |
| Rev.1.9 | 2026-11-28 | xzyozi | §1 の対象範囲（5パッケージ）・§4.4 の `e2e.yml` 自動検証・§4.6 の `generate-lockfile.yml` 記述整理を反映し、v0.1.0 リリースに向けて status を `approved` へ更新。                                                                                                             |
