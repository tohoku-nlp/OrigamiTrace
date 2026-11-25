import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { validateCommandResponse } from "../server/command-format.mjs";

const specification = JSON.parse(
  await readFile(new URL("../knowledge/command_specification.json", import.meta.url), "utf8"),
);
const block = (json) => "```json\n" + JSON.stringify(json) + "\n```";
const foldInfo = {
  crease_line_edge1: [0, -1],
  crease_line_edge2: [0, 1],
  source_point: [1, 0],
  target_point: [-1, 0],
  source_layers: ["all"],
  theta: 180,
  fold_type: "valley",
};
const fold = (overrides = {}) => ({
  command_name: "fold",
  parameters: { fold_infos: [{ ...foldInfo, ...overrides }] },
});
const check = (text, options) => validateCommandResponse(text, specification, options);

test("accepts a single command, a list, and a commands wrapper", () => {
  assert.equal(check(block(fold())).valid, true);
  assert.equal(check(block([fold(), { command_name: "rotate_3d", parameters: { theta_x: 0, theta_y: 180, theta_z: 0 } }])).commandCount, 2);
  assert.equal(check(block({ commands: [fold()] })).valid, true);
  assert.equal(check("Some reasoning first.\n" + block(fold())).valid, true);
});

test("uses the last valid code block", () => {
  const first = block(fold({ crease_line_edge2: [0, -1] })); // degenerate crease
  const second = block(fold({ crease_line_edge1: [0, 1], crease_line_edge2: [0, -1] }));
  const result = check(`${first}\nLet me fix that.\n${second}`);
  assert.equal(result.valid, true);
  assert.deepEqual(result.foldInfos[0].creaseLineEdge1, [0, 1]);
  assert.equal(check(`${block(fold())}\n\`\`\`json\n{broken}\n\`\`\``).valid, true);
});

test("rejects responses that do not follow the specification", () => {
  assert.equal(check("").valid, false);
  assert.equal(check("no code block").valid, false);
  assert.equal(check("```json\n{broken}\n```").valid, false);
  assert.equal(check(block({ command_name: "teleport", parameters: {} })).valid, false);
  assert.equal(check(block(fold({ theta: 200 }))).valid, false);
  assert.equal(check(block(fold({ fold_type: "squash" }))).valid, false);
  assert.equal(check(block(fold({ source_layers: [2, 1] }))).valid, false);
  assert.equal(check(block(fold({ pocket_point: [0, 0] }))).valid, false);
  assert.equal(check(block(fold({ pocket_point: [0, 0], destination_layer: [1, 3] }))).valid, false);
  assert.equal(check(block({ command_name: "rotate_3d", parameters: { theta_x: 0, theta_y: 270, theta_z: 0 } })).valid, false);
});

test("accepts lower layers only and insertion into a layer gap", () => {
  assert.equal(check(block(fold({ source_layers: [2] }))).valid, true);
  const inserted = check(block(fold({ pocket_point: [0, 0.2], destination_layer: [1, 2] })));
  assert.deepEqual(inserted.foldInfos[0].destinationLayer, [1, 2]);
});

test("a response without a code block is a question only in Task 2", () => {
  assert.equal(check("Which corner should I fold?", { allowQuestion: true }).kind, "question");
  assert.equal(check("Which corner should I fold?").valid, false);
});
