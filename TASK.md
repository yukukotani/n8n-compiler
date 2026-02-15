# TASK

## 実装方針（作業項目単位の Test First）
- 1作業項目ずつ RED→GREEN→REFACTOR を完了してから次へ進む
- RED ではその項目に必要な最小テストだけを書く（先回りで全項目分は書かない）
- GREEN はテストを通す最小実装に限定する
- REFACTOR で重複除去・命名整理・責務分離を行い、最後に `bun test` 全件実行

## 作業項目（依存順）

- [ ] 01. 土台構築（ディレクトリ/実行導線）
  RED: CLI最小スモークテスト（起動・引数エラー）を追加して失敗確認 / GREEN: `src` と `test` の骨組み、最小CLI実装 / REFACTOR: テスト共通ヘルパ整理

- [ ] 02. Diagnostics 基盤
  RED: `Diagnostic` 形状と主要エラーコードの期待テスト作成 / GREEN: 型・生成ヘルパ・整形実装 / REFACTOR: 生成APIを統一

- [ ] 03. パーサーアダプタ（`parse.ts`）
  RED: 正常解析と `E_PARSE` の失敗ケースを追加 / GREEN: `parseSync` ラッパ実装（推奨オプション適用） / REFACTOR: エラー変換ロジック整理

- [ ] 04. エントリ抽出（`extract-entry.ts`）
  RED: `export default workflow({...})` 抽出成功・失敗（`E_ENTRY_NOT_FOUND`/`E_EXECUTE_NOT_FOUND`） / GREEN: 抽出実装 / REFACTOR: AST走査責務を分離

- [ ] 05. DSL API/型（`src/dsl/*`）
  RED: Authoring API の型利用サンプルテスト（`workflow`, `n.expr`, `n.loop`） / GREEN: 型・公開API実装 / REFACTOR: 型エイリアス整理

- [ ] 06. IR定義と命名規則
  RED: `WorkflowIR/NodeIR/EdgeIR` と命名規則の期待テスト / GREEN: IR生成の最小実装 / REFACTOR: ID/キー生成ユーティリティを分離

- [ ] 07. CFG構築（MVP構文）
  RED: `Block/Expression/Variable/If/ForOf(n.loop)` の受理と非対応構文エラーのテスト / GREEN: CFG変換実装 / REFACTOR: 文ハンドラを分割

- [ ] 08. Lowering（逐次接続）
  RED: frontier 更新と順次接続テスト / GREEN: 逐次lowering実装 / REFACTOR: 接続生成ヘルパ統一

- [ ] 09. Lowering（`if`）
  RED: `if` ノード生成、true/false 出力index、`else` なし、`if(true/false)` 枝刈りテスト / GREEN: `if` lowering実装 / REFACTOR: 分岐合流ロジック整理

- [ ] 10. Lowering（`for..of n.loop()`）
  RED: `splitInBatches`、loop back-edge、done/loop 出力のテスト / GREEN: ループlowering実装 / REFACTOR: back-edge 検証補助を整理

- [ ] 11. connections 変換
  RED: canonical `connections` 形式・multi-output配列位置テスト / GREEN: 変換実装 / REFACTOR: 出力順安定化

- [ ] 12. バリデータ（`validate.ts`）
  RED: 必須項目、trigger存在、参照整合、if/loop配線の失敗テスト / GREEN: 検証実装 / REFACTOR: 検証フェーズを分割

- [ ] 13. compile 統合API
  RED: parse→extract→cfg/lower→validate の統合テスト / GREEN: `compile` 実装 / REFACTOR: パイプライン構成を整理

- [ ] 14. n8n APIクライアント（`n8n/client.ts`）
  RED: ヘッダ付与、401/409/ネットワークの診断変換、秘密情報マスクのテスト / GREEN: クライアント実装 / REFACTOR: HTTP層抽象化

- [ ] 15. deploy（`n8n/deploy.ts`）
  RED: create/update/upsert/activate の分岐テスト / GREEN: deploy実装 / REFACTOR: モード分岐整理

- [ ] 16. CLI本実装（`cli.ts`）
  RED: `compile/validate/deploy` と終了コード `0/1/2`、`--json` のE2Eテスト / GREEN: CLI実装 / REFACTOR: オプション解析を整理

- [ ] 17. スナップショット/統合テスト拡充
  RED: fixture追加で未対応ケースを顕在化 / GREEN: 必要最小修正で全通し / REFACTOR: fixture構成と命名を整理

- [ ] 18. README/運用ドキュメント更新
  RED: コマンド例・制約・エラーコードの不足チェックリスト / GREEN: ドキュメント更新 / REFACTOR: 重複説明整理

## 完了条件（MVP）
- [ ] `if` / `for..of n.loop()` を含む入力が compile 成功
- [ ] validate が構造・制御フロー不備を検出
- [ ] deploy(create/update/upsert) がモックで成功
- [ ] 同一入力で workflow JSON が決定的に一致
