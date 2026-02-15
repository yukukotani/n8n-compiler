# n8n-compiler

TypeScript で記述した workflow 定義を静的解析し、n8n workflow JSON へコンパイル/検証/デプロイする CLI です。

## セットアップ

```bash
bun install
```

## CLI クイックスタート

```bash
# compile
bun run cli -- compile ./examples/sample.workflow.ts --out ./dist/workflow.json

# validate
bun run cli -- validate ./examples/sample.workflow.ts

# deploy (環境変数利用)
N8N_BASE_URL="https://n8n.example.com" N8N_API_KEY="***" bun run cli -- deploy ./examples/sample.workflow.ts --mode upsert --activate
```

## ドキュメント

- 運用ガイド（コマンド例/制約/エラーコード/環境変数/終了コード）: `docs/operations.md`
- 作業項目 18 の RED チェックリスト: `docs/checklists/task-18-readme-ops-gap-checklist.md`

重複記載を避けるため、詳細仕様は `docs/operations.md` に集約しています。
