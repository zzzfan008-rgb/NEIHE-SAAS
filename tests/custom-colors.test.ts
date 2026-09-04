import assert from "node:assert/strict";
import { createCustomColorsStore } from "../src/store/customColors";

class MemoryStorage implements Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

console.log("账号隔离色彩偏好测试");
const storage = new MemoryStorage();
const store = createCustomColorsStore(storage);

store.getState().bindOwner("owner-a");
store.getState().add("#abc");
store.getState().rememberRecent("rgb(255, 0, 0)");
store.getState().toggleFavorite("hsl(240,100%,50%)");
assert.deepEqual(store.getState().colors, ["#AABBCC"]);
assert.deepEqual(store.getState().recent, ["#FF0000"]);
assert.deepEqual(store.getState().favorites, ["#0000FF"]);

store.getState().bindOwner(null);
assert.deepEqual(store.getState().colors, []);
assert.deepEqual(store.getState().recent, []);
assert.deepEqual(store.getState().favorites, []);

store.getState().bindOwner("owner-b");
assert.deepEqual(store.getState().colors, []);
store.getState().add("#123456");
store.getState().bindOwner("owner-a");
assert.deepEqual(store.getState().colors, ["#AABBCC"]);
assert.deepEqual(store.getState().recent, ["#FF0000"]);
assert.deepEqual(store.getState().favorites, ["#0000FF"]);
console.log("  ✓ A → logout → B → A 不枚举或覆盖其他账号偏好");

store.getState().remove("#aabbcc");
assert.deepEqual(store.getState().colors, []);
console.log("  ✓ 所有写入统一规范化，删除大小写无关");
