# ARCHITECTURE

## 1. このプロジェクトの目的

`n8n-compiler` は、TypeScript で書いた workflow DSL を **静的解析**し、n8n workflow JSON に変換する CLI です。
加えて、生成した workflow の検証・デプロイ、および既存 n8n workflow から DSL コードへの逆変換（import）を提供します。

重要な前提:
- ユーザーコードは実行しない（AST ベースの静的解析のみ）
- Bun 前提の実行環境
- 決定的（deterministic）な出力を重視

## 2. 全体アーキテクチャ

高レベル構成:

- `src/cli/main.ts`: コマンド入口とオーケストレーション
- `src/compiler/*`: DSL(TS) -> n8n JSON 変換パイプライン
- `src/importer/*`: n8n JSON -> DSL(TS) 逆変換
- `src/n8n/*`: n8n Public API クライアントと deploy 戦略
- `src/dsl/*`: ユーザーが書く authoring API（`workflow`, `n.*`）

依存方向（概略）:
- CLI -> Compiler / Importer / n8n
- Compiler -> DSL（trigger 種別定義）
- n8n client -> Compiler diagnostics（エラーコードを共通化）
- Importer は AST 解析に依存しない（グラフ復元中心）

## 3. ディレクトリ責務

```
src/
  cli.ts                      # 実行エントリ（runCli 呼び出し + process.exit）
  cli/
    main.ts                   # 引数解析、コマンド分岐、出力整形
  compiler/
    index.ts                  # barrel export
    parse.ts                  # oxc-parser ラッパ
    extract-entry.ts          # export default workflow({...}) 抽出
    ast-json.ts               # AST -> JSON/参照式 変換
    cfg.ts                    # execute から CFG 風中間表現を構築
    ir.ts                     # IR 型定義とファクトリ
    ir-identifiers.ts         # ノード key / 決定的 ID 生成
    lowering.ts               # CFG -> IR（ノード/エッジ）へ変換
    validate.ts               # IR 構造・配線検証
    layout.ts                 # dagre でノード座標を自動配置
    transform-params.ts       # DSL パラメータ -> n8n パラメータ変換
    connections.ts            # IR edge -> n8n connections 形式変換
    compile.ts                # 上記を統合するコンパイル本体
    diagnostics.ts            # Diagnostic 型・生成ヘルパ・整形
  importer/
    index.ts                  # barrel export
    generate.ts               # n8n graph -> DSL コード生成
    normalize-params.ts       # n8n パラメータ -> DSL パラメータ逆変換
    extract-workflow-id.ts    # import 対象 ID/URL 解析
  n8n/
    index.ts                  # barrel export
    client.ts                 # /api/v1/workflows* 呼び出し
    deploy.ts                 # create/update/upsert/activate の分岐
  dsl/
    index.ts                  # barrel export（workflow 関数, TRIGGER_NODE_KINDS）
    types.ts                  # 型定義（NodeKind, params, WorkflowDefinition 等）
    nodes.ts                  # n.* API 実装
test/
  unit/                       # 各モジュールの単体テスト
  integration/                # compile snapshot テスト
  fixtures/                   # テスト入力ファイル
  snapshots/                  # 期待出力 JSON
  helpers/                    # テストユーティリティ（cli, fixtures, snapshot）
examples/                     # DSL 記述例
docs/                         # 運用ガイド・ノード対応調査
```

## 4. メインフロー

### 4.1 compile / validate

`compile()`（`src/compiler/compile.ts`）の段階:

```
Source (.ts)
  │
  ├─ 1. Parse        parseSync()              -> Program AST
  ├─ 2. Extract       extractEntry()           -> name, settings, triggers, execute
  ├─ 3. Metadata      buildWorkflowMetadata()  -> name(string), settings(JSON)
  ├─ 4. Triggers      parseTriggers()          -> TriggerInput[]
  ├─ 5. CFG           buildControlFlowGraph()  -> CfgBlock
  ├─ 6. Lower         lowerControlFlowGraphToIR() -> WorkflowIR
  ├─ 7. Validate      validateWorkflow()       -> diagnostics
  ├─ 8. Layout        computeLayout()          -> NodePosition[]
  └─ 9. Emit          transformParameters() + buildN8nConnections()
                                               -> CompiledWorkflow
```

diagnostics があるステージで処理は停止し、`workflow=null` を返します。

`validate` コマンドは compile を呼び、workflow 出力せず診断だけ使います。

### 4.2 deploy

`deploy` コマンドは compile 成功後に `deployWorkflow` を呼びます。

- mode:
  - `create`: 常に作成
  - `update`: `--id` 必須で更新
  - `upsert`: 同名 workflow を検索し update/create 分岐
- `--activate` 指定時は deploy 後に activate API 呼び出し

### 4.3 import

`import` コマンドは以下の流れです。

1. 引数（ID or URL）から workflow ID 抽出
2. base URL / API key を引数・環境変数・URL から決定
3. `getWorkflow` で n8n JSON 取得
4. `generateWorkflowCode` で DSL TypeScript 生成
5. `--out` に書き出し

## 5. 主要データモデル

### Diagnostic

共通エラー形式。全フェーズで使用:

```ts
type Diagnostic = {
  code: DiagnosticCode;  // "E_PARSE" | "E_ENTRY_NOT_FOUND" | ...
  severity: "error" | "warning";
  message: string;
  file: string;
  start?: number;
  end?: number;
  hint?: string;
};
```

### CFG（制御フロー中間表現）

`execute` 関数の構文解析結果:

- `NodeCall`: `n.<node>(...)` 呼び出し
- `Variable`: `const x = n.<node>(...)` 呼び出し
- `If`: 条件分岐（`ExprCall` or `BooleanLiteral`）
- `Switch`: 多分岐（discriminant + cases + defaultCase）
- `ForOf`: ループ（`n.loop()` or ノード参照）
- `Parallel`: `n.parallel(() => {...}, ...)` による fan-out
- `Block`: 入れ子ブロック

### IR（中間表現）

```ts
type WorkflowIR = { name, settings, nodes: NodeIR[], edges: EdgeIR[] }
type NodeIR = { key, displayName?, n8nType, typeVersion, parameters, credentials?, position? }
type EdgeIR = { from, fromOutputIndex, to, toInputIndex, kind?: "loop-back" }
```

### 最終出力

```ts
type CompiledWorkflow = { name, settings, nodes: N8nNode[], connections: N8nConnections }
```

## 6. 制御フロー変換ルール（Lowering）

lowering は **frontier パターン**で実装されています。
frontier は「現在の到達可能出力ポート」のリストで、次のノードへの接続元になります。

- **逐次文**: frontier を次ノード入力へ接続し、frontier をそのノード出力で更新
- **`if`**:
  - `n8n-nodes-base.if` 1ノード生成
  - output 0（true）/ 1（false）を then/else に割当
  - 分岐終端 frontier をマージして後続へ
  - `if(true)` / `if(false)` は枝刈り（if ノード不生成）
- **`switch`**:
  - `n8n-nodes-base.switch` 生成
  - case ごとに output index を割当（0, 1, ...）
  - unmatched/default は `cases.length` の出力を使う
- **`for..of`**:
  - `n8n-nodes-base.splitInBatches` へ変換
  - output 1 が loop body、終端から loop ノードへ loop-back edge
  - output 0 がループ後 frontier
- **`n.parallel(...)`**:
  - 現 frontier を複数分岐へ複製（fan-out）
  - 全分岐終端 frontier をマージ

## 7. 式・参照解決

`src/compiler/ast-json.ts` と `src/compiler/cfg.ts` が担当します。

| TypeScript の式 | n8n 式への変換 |
|---|---|
| `res.data` | `={{$node["res"].json.data}}` |
| `res["content-type"]` | `={{$node["res"].json["content-type"]}}` |
| `res[0]` | `={{$node["res"].json[0]}}` |
| `item.name`（ループ変数） | `={{$json.name}}` |
| `` `.../${item.x}` `` | ``={{`.../${$json.x}`}}`` |

`if` 条件では以下を受理:
- `n.expr("={{...}}")` / boolean literal
- ノード参照式（`check.ok`, `check.ok == true`, `!check.ok`, `a && b`）

## 8. 名前・接続・レイアウトの設計

- ノード key:
  - 変数名があれば優先（`const req = ...` -> `req`）
  - なければ `<kind>_<counter>`
- displayName 優先順位:
  - `/** @name ... */` JSDoc > options.name > key
- 接続は最終出力時に key から displayName へリマップ
- `connections` は edge をソートして決定的順序で構築
- レイアウト（`src/compiler/layout.ts`）:
  - dagre で連結成分ごとに LR 配置
  - 複数成分は TB で縦積み
  - loop-back edge はレイアウト計算から除外（サイクル回避）
  - 16px グリッドへスナップ

## 9. n8n API 層

`src/n8n/client.ts`:

- 認証: `X-N8N-API-KEY` ヘッダ
- 利用エンドポイント:
  - `GET /api/v1/workflows` / `?name=...`
  - `POST /api/v1/workflows`
  - `PUT /api/v1/workflows/{id}`
  - `GET /api/v1/workflows/{id}`
  - `POST /api/v1/workflows/{id}/activate`
- エラー変換:
  - 401 -> `E_API_UNAUTHORIZED`
  - 409 -> `E_API_CONFLICT`
  - その他/通信障害 -> `E_API_NETWORK`
- API キーは診断メッセージ内で `***` にマスク
- `fetchFn` 注入でテスト時にモック可能

## 10. CLI 契約

コマンド:
- `compile <entry.ts> --out <file>`
- `validate <entry.ts>`
- `deploy <entry.ts> [--mode create|update|upsert] [--id <id>] [--activate]`
- `import <workflow-id-or-url> --out <file>`

共通オプション:
- `--json`: 機械処理向け JSON 出力
- `--base-url <url>`（fallback: `N8N_BASE_URL`）
- `--api-key <key>`（fallback: `N8N_API_KEY`）

終了コード:
- `0`: 成功
- `1`: compile/validate エラー
- `2`: deploy/API エラー
- `3`: import エラー

## 11. テスト戦略

テスト実行: `bun test`

| カテゴリ | 場所 | 内容 |
|---|---|---|
| unit | `test/unit/compiler.*.test.ts` | parse, extract-entry, cfg, lowering, validate, transform-params, connections, layout, ir, diagnostics |
| unit | `test/unit/dsl.*.test.ts` | authoring API の型利用確認 |
| unit | `test/unit/n8n.*.test.ts` | client（モック fetch）、deploy（モッククライアント） |
| unit | `test/unit/importer.*.test.ts` | generate, normalize-params, extract-workflow-id |
| unit | `test/unit/cli.*.test.ts` | smoke（起動/引数）、E2E（Bun サーバモック） |
| integration | `test/integration/compiler.snapshot.test.ts` | fixture -> compile -> snapshot 比較（決定性・複合制御フロー） |
| round-trip | `test/unit/importer.generate.test.ts` | generate -> compile 往復確認 |

fixture と snapshot は `test/fixtures/` と `test/snapshots/` に配置し、snapshot は `stableStringify`（キーソート済み JSON）で管理します。

## 12. 拡張ガイド（開発者/エージェント向け）

### 12.1 新しい DSL ノード追加

1. `src/dsl/types.ts`: `NodeKind` union と params 型を追加
2. `src/dsl/nodes.ts`: `n.<node>()` 関数を追加
3. `src/compiler/cfg.ts`: `SUPPORTED_NODE_CALLS` 配列に追加
4. `src/compiler/lowering.ts`: `NODE_TYPE_BY_KIND` にマッピング追加、必要なら `DEFAULT_TYPE_VERSION` も
5. 必要に応じて:
   - `src/compiler/transform-params.ts`（出力変換ルール）
   - `src/importer/normalize-params.ts`（逆変換ルール）
   - `src/importer/generate.ts`（`N8N_TYPE_TO_DSL_KIND` マッピング）
6. テスト: dsl authoring + cfg + lowering + compile + import round-trip

### 12.2 新しい制御構文追加

1. `src/compiler/cfg.ts`: `buildStatement` で構文受理と CFG 型追加
2. `src/compiler/lowering.ts`: `lowerStatement` で IR 化
3. `src/compiler/validate.ts`: 配線検証ルール追加
4. `src/importer/generate.ts`: 逆変換戦略を追加
5. integration snapshot を追加

### 12.3 CLI コマンド追加

1. `src/cli/main.ts`: `CommandName` / `SUPPORTED_COMMANDS` / 分岐 / usage を更新
2. JSON 出力と exit code 契約を定義
3. `test/unit/cli.*` に smoke/E2E を追加

## 13. 既知の制約と注意点

- 単一ファイル解析前提（`compile` は `sourceText` を直接解析。import/require の追跡なし）
- パラメータ解析は JSON 互換 + 一部参照式に限定（複雑な式は `null` 扱い）
- unsupported 構文は diagnostics で停止（部分コンパイルなし）
- importer は未対応 n8n ノードタイプを含むとエラー
- importer の生成 import パスは `"../src/dsl"` 固定
- compile 時は自動レイアウトが優先され、DSL の `position` 指定は実質上書きされる
- displayName 重複衝突の専用バリデーションは未実装

## 14. 設計上の不変条件（変更時に守ること）

- ユーザー workflow コードを実行しない（静的解析のみ）
- エラーは `Diagnostic` コード体系に統一する
- 出力は決定的順序を維持する（比較しやすい JSON diff のため）
- loop-back edge は配線検証では必要、レイアウト計算では除外
- compile / import 双方向の変換規則は可能な限り対称に保つ（`transform-params` <-> `normalize-params`）
- API キーやシークレットを診断メッセージに含めない
