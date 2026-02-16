import { expect, test, describe } from "bun:test";
import { computeLayout, type NodePosition } from "../../src/compiler/layout";
import type { EdgeIR, NodeIR } from "../../src/compiler/ir";

const GRID_SIZE = 16;

function makeNode(key: string, n8nType = "n8n-nodes-base.noOp"): NodeIR {
  return {
    key,
    n8nType,
    typeVersion: 1,
    parameters: {},
  };
}

function makeEdge(from: string, to: string, fromOutputIndex = 0): EdgeIR {
  return { from, to, fromOutputIndex, toInputIndex: 0 };
}

function positionOf(positions: NodePosition[], key: string): NodePosition {
  const found = positions.find((p) => p.nodeKey === key);
  if (!found) {
    throw new Error(`position not found for node: ${key}`);
  }
  return found;
}

describe("computeLayout", () => {
  test("空のノードリストに対しては空配列を返す", () => {
    const result = computeLayout([], []);
    expect(result).toEqual([]);
  });

  test("単一ノードは (0, 0) に配置される", () => {
    const nodes = [makeNode("trigger_1", "n8n-nodes-base.manualTrigger")];
    const result = computeLayout(nodes, []);
    expect(result).toHaveLength(1);
    expect(positionOf(result, "trigger_1")).toEqual({ nodeKey: "trigger_1", x: 0, y: 0 });
  });

  test("直線的なチェーン (A→B→C) はすべて左から右に配置される", () => {
    const nodes = [makeNode("a"), makeNode("b"), makeNode("c")];
    const edges = [makeEdge("a", "b"), makeEdge("b", "c")];
    const result = computeLayout(nodes, edges);

    expect(result).toHaveLength(3);

    const a = positionOf(result, "a");
    const b = positionOf(result, "b");
    const c = positionOf(result, "c");

    // 左から右の順序
    expect(b.x).toBeGreaterThan(a.x);
    expect(c.x).toBeGreaterThan(b.x);

    // すべて同じ Y (直線)
    expect(a.y).toBe(b.y);
    expect(b.y).toBe(c.y);
  });

  test("すべての座標が GRID_SIZE (16) の倍数にスナップされる", () => {
    const nodes = [makeNode("a"), makeNode("b"), makeNode("c"), makeNode("d")];
    const edges = [makeEdge("a", "b"), makeEdge("b", "c"), makeEdge("c", "d")];
    const result = computeLayout(nodes, edges);

    for (const pos of result) {
      expect(pos.x % GRID_SIZE).toBe(0);
      expect(pos.y % GRID_SIZE).toBe(0);
    }
  });

  test("if 分岐 (A→B, A→C) は B と C を異なる Y に配置する", () => {
    const nodes = [
      makeNode("trigger_1", "n8n-nodes-base.manualTrigger"),
      makeNode("if_2", "n8n-nodes-base.if"),
      makeNode("true_3"),
      makeNode("false_4"),
    ];
    const edges = [
      makeEdge("trigger_1", "if_2"),
      makeEdge("if_2", "true_3", 0),
      makeEdge("if_2", "false_4", 1),
    ];
    const result = computeLayout(nodes, edges);

    const ifPos = positionOf(result, "if_2");
    const truePos = positionOf(result, "true_3");
    const falsePos = positionOf(result, "false_4");

    // true/false ブランチは if より右
    expect(truePos.x).toBeGreaterThan(ifPos.x);
    expect(falsePos.x).toBeGreaterThan(ifPos.x);

    // true と false は同じ X
    expect(truePos.x).toBe(falsePos.x);

    // true と false は異なる Y
    expect(truePos.y).not.toBe(falsePos.y);
  });

  test("if 分岐後の合流ノードは分岐より右に配置される", () => {
    const nodes = [
      makeNode("trigger_1", "n8n-nodes-base.manualTrigger"),
      makeNode("if_2", "n8n-nodes-base.if"),
      makeNode("true_3"),
      makeNode("false_4"),
      makeNode("merge_5"),
    ];
    const edges = [
      makeEdge("trigger_1", "if_2"),
      makeEdge("if_2", "true_3", 0),
      makeEdge("if_2", "false_4", 1),
      makeEdge("true_3", "merge_5"),
      makeEdge("false_4", "merge_5"),
    ];
    const result = computeLayout(nodes, edges);

    const truePos = positionOf(result, "true_3");
    const falsePos = positionOf(result, "false_4");
    const mergePos = positionOf(result, "merge_5");

    expect(mergePos.x).toBeGreaterThan(truePos.x);
    expect(mergePos.x).toBeGreaterThan(falsePos.x);
  });

  test("loop-back エッジはレイアウト計算に使用されない（サイクル回避）", () => {
    const nodes = [
      makeNode("trigger_1", "n8n-nodes-base.manualTrigger"),
      makeNode("loop_2", "n8n-nodes-base.splitInBatches"),
      makeNode("body_3"),
      makeNode("done_4"),
    ];
    const edges: EdgeIR[] = [
      makeEdge("trigger_1", "loop_2"),
      makeEdge("loop_2", "done_4", 0),
      makeEdge("loop_2", "body_3", 1),
      { from: "body_3", to: "loop_2", fromOutputIndex: 0, toInputIndex: 0, kind: "loop-back" },
    ];
    const result = computeLayout(nodes, edges);

    expect(result).toHaveLength(4);

    const loop = positionOf(result, "loop_2");
    const body = positionOf(result, "body_3");
    const done = positionOf(result, "done_4");

    // body は loop より右（back-edge が無視されてサイクルにならない）
    expect(body.x).toBeGreaterThan(loop.x);
    expect(done.x).toBeGreaterThan(loop.x);
  });

  test("同一入力に対して決定的な結果を返す", () => {
    const nodes = [
      makeNode("trigger_1", "n8n-nodes-base.manualTrigger"),
      makeNode("if_2", "n8n-nodes-base.if"),
      makeNode("a"),
      makeNode("b"),
      makeNode("c"),
    ];
    const edges = [
      makeEdge("trigger_1", "if_2"),
      makeEdge("if_2", "a", 0),
      makeEdge("if_2", "b", 1),
      makeEdge("a", "c"),
      makeEdge("b", "c"),
    ];

    const result1 = computeLayout(nodes, edges);
    const result2 = computeLayout(nodes, edges);

    expect(result1).toEqual(result2);
  });

  test("接続のないノードが複数ある場合、縦に積み上げられる", () => {
    const nodes = [makeNode("a"), makeNode("b")];
    const edges: EdgeIR[] = [];
    const result = computeLayout(nodes, edges);

    expect(result).toHaveLength(2);

    const a = positionOf(result, "a");
    const b = positionOf(result, "b");

    // 接続がないノードは独立した連結成分になり、縦に積まれる
    // x は同じ（両方 0）になるか、少なくとも y が異なる
    expect(a.x).toBe(b.x);
    expect(a.y).not.toBe(b.y);
  });
});
