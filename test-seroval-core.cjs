const { encodeArgs, decodeStream, decodeJsonOrStream } = require('./seroval-core.cjs');
const assert = require('assert');

// 1) decode samples (from seroval 1.3.2 / production)
const samples = [
  '(($R=>$R[0]={mine:!0,useBalance:!1,rollingUsage:$R[1]={status:"ok",resetInSec:3600,usagePercent:42},timeCreated:$R[2]=new Date("2026-08-01T00:00:00.000Z"),maybe:void 0})($R["server-fn:0"]))',
  '(($R=>$R[0]=[$R[1]={x:1},$R[1]])($R["server-fn:0"]))',
  '((self.$R=self.$R||{})["server-fn:py-test"]=[],($R=>$R[0]=[$R[1]={model:"gpt-5.6-luna",inputTokens:0,timeCreated:$R[2]=new Date("2026-08-01T00:00:00.000Z")}])("server-fn:py-test"))',
];
let v = decodeStream(samples[0]);
assert.strictEqual(v.mine, true);
assert.strictEqual(v.useBalance, false);
assert.strictEqual(v.rollingUsage.usagePercent, 42);
assert.strictEqual(v.timeCreated, '2026-08-01T00:00:00.000Z');
assert.strictEqual(v.maybe, null);
assert.deepStrictEqual(decodeStream(samples[1]), [{ x: 1 }, { x: 1 }]);
assert.strictEqual(decodeStream(samples[2])[0].model, 'gpt-5.6-luna');

// 2) framed + void
assert.strictEqual(decodeStream(';0x00000036;((self.$R=self.$R||{})["server-fn:py-test"]=[],void 0)'), null);
assert.deepStrictEqual(decodeStream(';0x00000026;(($R=>$R[0]={a:1})($R["server-fn:2"]))'), { a: 1 });

// 3) plain JSON passthrough
assert.deepStrictEqual(decodeJsonOrStream('{"x":1}'), { x: 1 });

// 4) encode args -> compare structure with python/node seroval
const enc = JSON.parse(encodeArgs(["wrk_01ABC", 0, { a: 1, b: null, c: true, d: "x" }, ["nested", 3.5], null]));
assert.strictEqual(enc.t.t, 9);
assert.strictEqual(enc.t.l, 5);
assert.strictEqual(enc.t.a[0].s, "wrk_01ABC");
assert.deepStrictEqual(enc.t.a[1], { t: 0, s: 0 });
assert.strictEqual(enc.t.a[2].t, 10);
assert.deepStrictEqual(enc.t.a[2].p.k, ["a", "b", "c", "d"]);
assert.deepStrictEqual(enc.m, []);
console.log("seroval-core JS tests OK");

