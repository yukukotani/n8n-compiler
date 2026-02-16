# 運用ガイド

このドキュメントは `n8n-compiler` の日常運用向けに、CLI の使い方と制約をまとめたものです。

## コマンド例

`bun run cli -- <command> ...` 形式で実行します。

### compile

```bash
bun run cli -- compile ./workflows/order.workflow.ts --out ./dist/order.workflow.json
```

- 入力: `export default workflow({...})` を含む TypeScript ファイル
- 出力: n8n workflow JSON（`--out` で指定したファイル）

### validate

```bash
bun run cli -- validate ./workflows/order.workflow.ts
```

- コンパイル可能性と workflow 構造妥当性を検証
- 問題がなければ終了コード `0`

### deploy

```bash
# 例1: 環境変数で資格情報を渡す
N8N_BASE_URL="https://n8n.example.com" N8N_API_KEY="***" bun run cli -- deploy ./workflows/order.workflow.ts --mode upsert --activate

# 例2: 引数で資格情報を渡す
bun run cli -- deploy ./workflows/order.workflow.ts --mode update --id wf_123 --base-url "https://n8n.example.com" --api-key "***"
```

- `--mode` は `create | update | upsert`（省略時 `upsert`）
- `--mode update` では `--id` が必須
- `--activate` 指定時は deploy 後に activate API を呼び出す

## サポート構文と制約

MVP サポートは次の通りです。

### triggers パラメータ

- `triggers` は配列リテラルで、1 つ以上のトリガーノードを指定します
- 例: `triggers: [n.manualTrigger()]`
- スケジュール例: `triggers: [n.scheduleTrigger({ schedules: [{ type: "minutes", intervalMinutes: 5 }] })]`
- Webhook 例: `triggers: [n.webhookTrigger({ path: "incoming", httpMethod: "POST" })]`
- 複数指定可: `triggers: [n.manualTrigger(), n.scheduleTrigger({ schedules: [{ type: "hours", intervalHours: 1 }] })]`
- 現在サポートされる trigger は `manualTrigger / scheduleTrigger / webhookTrigger`
- `scheduleTrigger` の `schedules` は `type` による判別共用体で、`type` に応じたパラメータを指定します:
  - `seconds`: `intervalSeconds`
  - `minutes`: `intervalMinutes`
  - `hours`: `intervalHours`, `atMinute?`
  - `days`: `intervalDays`, `atHour?`, `atMinute?`
  - `weeks`: `intervalWeeks`, `onWeekdays?`, `atHour?`, `atMinute?`
  - `months`: `intervalMonths`, `atDayOfMonth?`, `atHour?`, `atMinute?`
  - `cron`: `expression`
- トリガーノード（`n.manualTrigger(...)`, `n.scheduleTrigger(...)`, `n.webhookTrigger(...)`）は `execute` 内に書くとエラーになります

### execute 内のサポート構文

- ブロック文: `{ ... }`
- DSL ノード呼び出し:
  - `n.httpRequest(...)`
  - `n.respondToWebhook(...)`
  - `n.merge(...)`
  - `n.wait(...)`
  - `n.filter(...)`
  - `n.splitOut(...)`
  - `n.aggregate(...)`
  - `n.sort(...)`
  - `n.limit(...)`
  - `n.removeDuplicates(...)`
  - `n.summarize(...)`
  - `n.code(...)`
  - `n.executeWorkflow(...)`
  - `n.switch(...)`（ノードとして直接呼ぶ場合）
  - `n.set(...)`
  - `n.noOp(...)`
- 変数代入つきノード呼び出し: `const req = n.httpRequest(...)`
- 条件分岐: `if (check.ok) { ... }`, `if (check.ok == true) { ... }`, `if (n.expr("={{...}}")) { ... }`
- 条件分岐（定数枝刈り）: `if (true) { ... }`, `if (false) { ... }`
- `switch` 構文: `switch (expr) { case ...: ...; break; default: ... }`
- ループ: `for (const item of n.loop({...})) { ... }`

### 非サポート/制約

- `execute` はブロックボディを持つ関数式/アロー関数である必要がある
- トリガーノード（`n.manualTrigger(...)`, `n.scheduleTrigger(...)`, `n.webhookTrigger(...)`）を `execute` 内で使うことは非対応（`triggers` に指定）
- 未知の DSL 呼び出し（例: `n.unknownNode(...)`）は非対応
- `n.expr(...)` と `n.loop(...)` を単独ノード呼び出しとして使うことは非対応
- `if` 条件は boolean リテラル、`n.expr(...)`、または前ノード参照を使う式（例: `check.ok`, `check.ok == true`, `!check.ok`, `check.count > 0`, `check.ok && check.ready`）に対応
- `switch` 条件式はシリアライズ可能な式のみ対応、`case` は literal（`string/number/boolean/null`）のみ対応
- `switch` の fallthrough は非対応（`break` が必要）
- `for await...of` は非対応
- `for...of` は `const` で 1 つの識別子束縛が必須
- `for...of` の右辺は `n.loop(...)` のみ対応
- `return` / `while` など、MVP 対象外ステートメントは非対応
- `workflow.name` は文字列リテラル必須
- `workflow.settings` は JSON オブジェクトリテラル必須（省略時 `{}`）
- `workflow.triggers` は配列リテラル必須、1 つ以上のトリガーが必要

## 主なエラーコード

| コード | 主な発生条件 |
| --- | --- |
| `E_PARSE` | TypeScript の構文解析に失敗、または入力ファイルの読み取り失敗 |
| `E_ENTRY_NOT_FOUND` | `export default workflow({...})` が見つからない |
| `E_EXECUTE_NOT_FOUND` | `workflow({...})` 内に `execute` が見つからない |
| `E_TRIGGERS_NOT_FOUND` | `workflow({...})` 内に `triggers` 配列が見つからない |
| `E_INVALID_TRIGGER` | `triggers` 配列の要素が不正（空配列、不明なトリガー種別など） |
| `E_UNSUPPORTED_STATEMENT` | MVP 非対応の文、または許可されない呼び出し形式（execute 内の trigger 呼び出し含む） |
| `E_UNSUPPORTED_IF_TEST` | `if` 条件が対応式（boolean / `n.expr(...)` / 前ノード参照式）以外 |
| `E_UNSUPPORTED_FOR_FORM` | `for...of` の形が制約違反（`for await...of` 含む） |
| `E_INVALID_LOOP_SOURCE` | `for...of` の右辺が `n.loop(...)` ではない |
| `E_UNKNOWN_NODE_CALL` | 未知の `n.<node>(...)` 呼び出し |
| `E_INVALID_CONNECTION` | ノード配線不整合（参照不正、if/loop の配線欠落など） |
| `E_INVALID_WORKFLOW_SCHEMA` | workflow 必須項目不備、name/settings 形式不正 |
| `E_API_UNAUTHORIZED` | n8n API が 401 を返した |
| `E_API_CONFLICT` | n8n API が 409 を返した |
| `E_API_NETWORK` | API 通信失敗、または 401/409 以外の API エラー |

`--json` 指定時は失敗時に `diagnostics` 配列を JSON で返します。

## 環境変数

- `N8N_BASE_URL`: deploy 先 n8n のベース URL
- `N8N_API_KEY`: n8n Public API キー

`deploy` は `--base-url` / `--api-key` が未指定なら上記環境変数を参照します。

## 終了コード

- `0`: 成功
- `1`: compile/validate エラー（診断あり）
- `2`: deploy/API エラー

## 運用メモ

- `--json` を使うと CI で機械処理しやすい
- API キーは診断メッセージ内でマスクされる
