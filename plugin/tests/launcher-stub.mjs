#!/usr/bin/env node
// launcher-stub.mjs — заглушка «хук-скрипта» для тестов лаунчера.
//
// Печатает маркер: тест считает, что лаунчер ПРОПУСТИЛ событие, если маркера нет
// (значит, Node не запускался). Читает stdin целиком, как настоящий хук.
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (buf += d));
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ passed_through: true, bytes: buf.length }) + "\n");
  process.exit(0);
});
