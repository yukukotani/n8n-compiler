# ノード対応調査（httpRequest以外）

## 現在の対応状況（このリポジトリ）

- DSL の `NodeKind` は P0 対応済み（`manualTrigger / scheduleTrigger / webhookTrigger / httpRequest / respondToWebhook / switch / merge / wait / filter / splitOut / aggregate / sort / limit / removeDuplicates / summarize / code / executeWorkflow / set / noOp`）
- `execute` 内で許可される DSL 呼び出しも P0 対応済み（trigger 以外）
- 制御構文から合成されるノードは `if / splitInBatches / switch` を実装済み
- `switch` は TypeScript 標準構文（`switch (...) { case ...: ...; break; default: ... }`）から変換

参照:
- `src/dsl/types.ts`
- `src/compiler/cfg.ts`
- `src/compiler/lowering.ts`

## 選定方針

1. n8n公式で「Core node」として定義され、汎用性が高いこと
2. 本コンパイラの既存構造（NodeKind追加 + loweringマップ + params変換）で段階導入しやすいこと
3. 実運用で頻出なフロー制御・データ整形・入口/出口を優先すること

---

## 対応すべきノード一覧（優先度順）

### P0（最優先: 実用性を一気に上げる）

完了（2026-02-17 時点）

| 優先度 | DSL名（案） | n8n type | 種別 | 理由 |
|---|---|---|---|---|
| P0 | `webhookTrigger` | `n8n-nodes-base.webhook` | Trigger | 外部イベント起点の基本。HTTP入口を作れる |
| P0 | `respondToWebhook` | `n8n-nodes-base.respondToWebhook` | Action | Webhook応答制御に必須（APIエンドポイント化） |
| P0 | `switch` | `n8n-nodes-base.switch` | Flow | `if` より多分岐を表現できる |
| P0 | `merge` | `n8n-nodes-base.merge` | Flow | 分岐後の再結合に必須 |
| P0 | `wait` | `n8n-nodes-base.wait` | Flow | レート制御・非同期待機で高頻度 |
| P0 | `filter` | `n8n-nodes-base.filter` | Data | 条件フィルタの基本 |
| P0 | `splitOut` | `n8n-nodes-base.splitout` | Data | 配列を item 化する基本整形 |
| P0 | `aggregate` | `n8n-nodes-base.aggregate` | Data | item 群の集約に必須 |
| P0 | `sort` | `n8n-nodes-base.sort` | Data | 実務で頻出の並び替え |
| P0 | `limit` | `n8n-nodes-base.limit` | Data | 件数制限の基本操作 |
| P0 | `removeDuplicates` | `n8n-nodes-base.removeduplicates` | Data | 重複除去（実行内/実行間） |
| P0 | `summarize` | `n8n-nodes-base.summarize` | Data | 集計（ピボット系）需要が高い |
| P0 | `code` | `n8n-nodes-base.code` | Data/Logic | 取りこぼしユースケースの逃げ道として必要 |
| P0 | `executeWorkflow` | `n8n-nodes-base.executeWorkflow` | Flow | サブワークフロー分割・再利用に必須 |

### P1（次点: 実運用の入口を強化）

| 優先度 | DSL名（案） | n8n type | 種別 | 理由 |
|---|---|---|---|---|
| P1 | `formTrigger` | `n8n-nodes-base.formtrigger` | Trigger | フォーム起点の取り込み |
| P1 | `form` | `n8n-nodes-base.form` | Action | 入力UIを組み込む用途 |
| P1 | `errorTrigger` | `n8n-nodes-base.errortrigger` | Trigger | 障害時フローの標準化 |
| P1 | `workflowTrigger` | `n8n-nodes-base.workflowtrigger` | Trigger | ワークフロー間連携の入口 |
| P1 | `graphql` | `n8n-nodes-base.graphql` | Action | API連携の主要手段（HTTP補完） |
| P1 | `readWriteFile` | `n8n-nodes-base.readwritefile` | Action | ファイル連携ニーズ対応 |
| P1 | `sendEmail` | `n8n-nodes-base.sendemail` | Action | 通知の基本チャネル |

### P2（方針決定後: Appノード群）

`Google Sheets / Slack / Notion / Postgres / MySQL / Redis / GitHub` などは需要が高いが、
個別DSLを増やすよりも、下記の汎用化方針を先に決めるのが望ましい。

- 例: `n.node("n8n-nodes-base.postgres", params)` のような汎用ノード呼び出し
- その上で主要 app node の型ラッパーを段階提供

---

## 備考（調査ソース）

- n8n Built-in node types（Core nodesの定義）
  - https://docs.n8n.io/integrations/builtin/node-types/
- Core nodes 一覧（公式ナビゲーション）
  - https://docs.n8n.io/integrations/builtin/core-nodes/
- フロー制御の重要ノード
  - Splitting: IF / Switch
    https://docs.n8n.io/flow-logic/splitting/
  - Merging: Merge / Code
    https://docs.n8n.io/flow-logic/merging/
  - Waiting: Wait
    https://docs.n8n.io/flow-logic/waiting/
  - Looping: Loop Over Items / IF
    https://docs.n8n.io/flow-logic/looping/
- データ変換ノードの推奨セット
  - https://docs.n8n.io/data/transforming-data/
