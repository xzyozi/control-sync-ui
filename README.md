# control-sync-ui

ブラウザ側に状態の正本と決定論的な計算ロジックを持たせ、外部PCの画面操作（制御状態）に応じてデータ送信を動的に制御する、UI非依存のTypeScript同期基盤です。Gitサブモジュールとして親プロジェクトへ組み込んで利用します（リポジトリ名: `control-sync-ui`）。

## パッケージ構成

| パッケージ | 役割 |
| :--- | :--- |
| `@csu/core` (`packages/core`) | 純粋 TypeScript コア（Domain Store / Control Store / Reactive Outbox / Sync Engine / `StoragePort` / `TransportPort`）。ブラウザ API・外部依存なし |
| `@csu/storage-indexeddb` (`packages/storage-indexeddb`) | `StoragePort` の IndexedDB 実装（原子的追記・`storageVersion` 検証） |
| `@csu/transport-http` (`packages/transport-http`) | `TransportPort` の HTTP / SSE（`fetch` / `EventSource`）実装 |
| `@csu/relay` (`packages/relay`) | 検証・参照用リレーサーバー（Room 分離・`controlSeq` 発行・lease / presence 判定・HTTP / SSE 層） |
| `@csu/demo` (`packages/demo`) | 2画面（対象端末・外部PC）動作確認用デモアプリ・4パッケージ結合テスト・Chromium E2E |

## 検証・ビルド

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

2画面デモの起動:

```bash
npm --workspace=@csu/demo start
```

## ドキュメント

- [最小要件定義書（v0.1 MVP）](docs/features/CSU-REQ-001_最小要件定義書.md)
- [基本設計書](docs/design/CSU-BD-001_基本設計書.md) / [IF仕様書](docs/design/CSU-IF-001_IF仕様書.md) / [詳細設計書](docs/design/CSU-DD-001_詳細設計書.md) / [データ構造仕様書](docs/design/CSU-DS-001_データ構造仕様書.md)
- [環境・開発基盤仕様書](docs/setup/CSU-ENV-001_環境・開発基盤仕様書.md)（品質ゲート・版の方針）
- [サブモジュール統合手順書](docs/how-to/submodule_integration.md)（[ADR-008](docs/adr/ADR-008_サブモジュールとしての消費方式.md)）
- [ドキュメントガバナンス](docs/README.md) / [用語集](CONTEXT.md) / [Git Flow 運用規約](docs/setup/git_flow_and_branch_policy.md)

## 後続課題

ロードマップは [#20](https://github.com/xzyozi/control-sync-ui/issues/20)、後続課題は [GitHub Issues](https://github.com/xzyozi/control-sync-ui/issues) で管理しています。
