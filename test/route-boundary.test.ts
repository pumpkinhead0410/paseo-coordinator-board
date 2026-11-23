import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// 확정 결정 2(내장 추천표로 되돌아가지 않음)와 프로세스 실행 위치를 빌드 실패로 지킨다.
const root = join(import.meta.dir, "..");

function sources(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap(name => {
    const path = join(dir, name);
    if (name === "vendor" || name === "node_modules") return [];
    if (statSync(join(root, path)).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}
const files = [...sources("client"), ...sources("server"), ...sources("shared"), "index.client.tsx", "index.server.ts"];
const text = (path: string) => readFileSync(join(root, path), "utf8");
const using = (pattern: RegExp) => files.filter(path => pattern.test(text(path))).sort();

test("추천표 경로(resolveRoute·preferCapacity)는 정의한 파일과 server/routes.ts 밖에서 쓰이지 않는다", () => {
  expect(using(/\bresolveRoute\b/)).toEqual(["server/routes.ts", "shared/dispatch.ts"]);
  expect(using(/\bpreferCapacity\b/)).toEqual(["shared/dispatch.ts", "shared/usage-routing.ts"]);
  expect(using(/\brecommendations\b/)).toEqual(["shared/dispatch.ts"]);
});

test("child_process는 server/profile-host.ts에서만 쓴다", () => {
  expect(using(/child_process/)).toEqual(["server/profile-host.ts"]);
});

test("화면(client)은 서버 모듈을 가져오지 않는다", () => {
  const offenders = files.filter(path => path.startsWith("client/") && /from\s+["']\.\.\/server\//.test(text(path)));
  expect(offenders).toEqual([]);
});

test("모듈 입구: ProfileHost는 Router만, Router는 dispatch·operations만 가져간다", () => {
  const importers = (module: string) => files.filter(path => new RegExp(`from\\s+["']\\./${module}["']`).test(text(path))).sort();
  expect(importers("profile-host")).toEqual(["server/routes.ts"]);
  expect(importers("routes")).toEqual(["server/dispatch.ts", "server/operations.ts"]);
});
