import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import { createAdminRouter } from "../src/routes/admin.routes.ts";

// No database connection: unexpected queries fail the request instead of touching .env.
process.env.JWT_SECRET = "admin-tests-only-never-used-in-production";
const admin = "admin-test-id";
const user = "ordinary-user-id";

async function fixture(t, configure = () => {}, ids = [admin]) {
  const unexpected = async () => { throw new Error("Unexpected database operation"); };
  const db = {};
  for (const model of ["user", "room", "wallStroke", "chatMessage", "roomMember"]) {
    db[model] = Object.fromEntries(["findUnique", "findMany", "count", "create", "update", "delete", "deleteMany"].map((name) => [name, unexpected]));
  }
  db.user.findUnique = async ({ where }) => where.id === admin ? { id: admin } : null;
  db.$transaction = async (fn) => fn(db);
  const events = [];
  const audit = [];
  configure(db);
  const app = express();
  app.use(express.json());
  app.use("/api/admin", createAdminRouter({ db, adminIds: () => ids,
    realtime: { emitRoom: (...args) => events.push(args), disconnectUser: (id) => events.push(["disconnect", id]) },
    audit: (entry) => audit.push(entry),
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  async function request(path, { actor = admin, method = "GET", body, token } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (actor !== null) headers.Authorization = `Bearer ${token ?? jwt.sign({ userId: actor }, process.env.JWT_SECRET)}`;
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin${path}`, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  return { request, events, audit };
}

test("all admin resources reject unauthenticated and ordinary users before querying data", async (t) => {
  const { request } = await fixture(t);
  for (const [path, method] of [["/me", "GET"], ["/users", "GET"], ["/users", "POST"], ["/users/id", "PATCH"], ["/users/id", "DELETE"], ["/rooms", "GET"], ["/rooms", "POST"], ["/rooms/id", "PATCH"], ["/rooms/id", "DELETE"], ["/rooms/id/strokes", "DELETE"], ["/strokes", "GET"], ["/strokes/id", "GET"], ["/strokes/id", "DELETE"], ["/strokes/id", "PATCH"]]) {
    assert.equal((await request(path, { actor: null, method })).status, 401, path);
    assert.equal((await request(path, { actor: user, method })).status, 403, path);
  }
});
test("invalid tokens and deleted administrator accounts are denied", async (t) => {
  const { request } = await fixture(t, (db) => { db.user.findUnique = async () => null; });
  assert.equal((await request("/me", { token: "invalid" })).status, 401);
  assert.equal((await request("/me")).status, 401);
});
test("empty administrator configuration denies access", async (t) => {
  const { request } = await fixture(t, () => {}, []);
  assert.equal((await request("/me")).status, 403);
});
test("users are paginated and selected without passwords or verification codes", async (t) => {
  const { request } = await fixture(t, (db) => {
    db.user.findMany = async ({ select, skip, take, where }) => {
      assert.equal(select.passwordHash, undefined);
      assert.equal(skip, 25); assert.equal(take, 25);
      assert.equal(where.OR[1].email.contains, "example");
      return [{ id: user, email: "test@example.invalid" }];
    };
    db.user.count = async () => 30;
  });
  const result = await request("/users?page=2&q=example");
  assert.equal(result.status, 200); assert.equal(result.data.data.total, 30);
  assert.equal(result.data.data.items[0].isAdmin, false);
  assert.equal(result.headers.get("cache-control"), "no-store");
  for (const page of ["0", "-1", "NaN", "1.5", "9999999"]) assert.equal((await request(`/users?page=${page}`)).status, 400);
});
test("user creation validates and hashes passwords and ignores privilege injection", async (t) => {
  const { request, audit } = await fixture(t, (db) => {
    db.user.create = async ({ data, select }) => {
      assert.equal(data.email, "new@example.invalid");
      assert.match(data.passwordHash, /^\$2[aby]\$/);
      assert.equal(data.isAdmin, undefined); assert.equal(data.role, undefined);
      assert.equal(select.passwordHash, undefined);
      return { id: user, email: data.email };
    };
  });
  assert.equal((await request("/users", { method: "POST", body: { email: "bad", password: "short" } })).status, 400);
  const result = await request("/users", { method: "POST", body: { email: "NEW@example.invalid", password: "test-password-123", role: "admin", isAdmin: true } });
  assert.equal(result.status, 201); assert.equal(result.data.data.passwordHash, undefined);
  assert.equal(audit[0].action, "user.create"); assert.equal(JSON.stringify(audit).includes("test-password"), false);
});
test("editing a user writes only the allowed fields", async (t) => {
  const { request } = await fixture(t, (db) => {
    db.user.update = async ({ where, data }) => {
      assert.equal(where.id, user);
      assert.deepEqual(data, { email: "next@example.invalid", name: "New name" });
      return { id: user, ...data };
    };
  });
  assert.equal((await request(`/users/${user}`, { method: "PATCH", body: { email: "next@example.invalid", name: "New name", passwordHash: "injected", schoolId: "injected", role: "ADMIN" } })).status, 200);
});
test("deletion requires an exact confirmation and cannot delete administrators", async (t) => {
  const { request } = await fixture(t);
  assert.equal((await request(`/users/${user}`, { method: "DELETE", body: { confirmation: "wrong" } })).status, 400);
  assert.equal((await request(`/users/${admin}`, { method: "DELETE", body: { confirmation: admin } })).status, 409);
  assert.equal((await request("/rooms/room/strokes", { method: "DELETE", body: {} })).status, 400);
});
test("a user who still owns rooms cannot be deleted", async (t) => {
  const { request } = await fixture(t, (db) => {
    db.user.findUnique = async ({ where }) => ({ id: where.id });
    db.room.count = async () => 1;
  });
  assert.equal((await request(`/users/${user}`, { method: "DELETE", body: { confirmation: user } })).status, 409);
});
test("user deletion scopes related rows and notifies affected rooms", async (t) => {
  const deleted = [];
  const { request, events } = await fixture(t, (db) => {
    db.user.findUnique = async ({ where }) => ({ id: where.id });
    db.room.count = async () => 0;
    db.room.findMany = async () => [{ id: "room-a" }];
    for (const model of ["wallStroke", "chatMessage", "roomMember"]) db[model].deleteMany = async ({ where }) => {
      assert.deepEqual(where, model === "roomMember" ? { userId: user } : { authorId: user }); deleted.push(model); return { count: 1 };
    };
    db.user.delete = async ({ where }) => { assert.equal(where.id, user); deleted.push("user"); };
  });
  assert.equal((await request(`/users/${user}`, { method: "DELETE", body: { confirmation: user } })).status, 200);
  assert.deepEqual(deleted, ["wallStroke", "chatMessage", "roomMember", "user"]);
  assert.deepEqual(events[0], ["disconnect", user]); assert.equal(events[1][0], "room-a");
});
test("clearing a board only deletes strokes in that room and emits after success", async (t) => {
  const { request, events, audit } = await fixture(t, (db) => {
    db.room.findUnique = async () => ({ id: "room-a" });
    db.wallStroke.deleteMany = async ({ where }) => { assert.deepEqual(where, { roomId: "room-a" }); return { count: 3 }; };
  });
  const result = await request("/rooms/room-a/strokes", { method: "DELETE", body: { confirmation: "room-a" } });
  assert.equal(result.status, 200); assert.equal(result.data.data.count, 3);
  assert.deepEqual(events, [["room-a", "room-content-changed", { roomId: "room-a" }]]);
  assert.equal(audit[0].count, 3);
});
test("failed transactions never announce successful clearing", async (t) => {
  const { request, events, audit } = await fixture(t, (db) => { db.$transaction = async () => { throw new Error("private database detail"); }; });
  const result = await request("/rooms/room-a/strokes", { method: "DELETE", body: { confirmation: "room-a" } });
  assert.equal(result.status, 500); assert.equal(JSON.stringify(result.data).includes("private database"), false);
  assert.deepEqual(events, []); assert.deepEqual(audit, []);
});
test("school rooms cannot be deleted", async (t) => {
  const { request } = await fixture(t, (db) => { db.room.findUnique = async () => ({ type: "SCHOOL" }); });
  assert.equal((await request("/rooms/school-room", { method: "DELETE", body: { confirmation: "school-room" } })).status, 409);
});
test("stroke deletion requires both the record ID and room ID", async (t) => {
  const { request, events } = await fixture(t, (db) => {
    db.wallStroke.deleteMany = async ({ where }) => { assert.deepEqual(where, { id: "stroke-a", roomId: "room-a" }); return { count: 1 }; };
  });
  assert.equal((await request("/strokes/stroke-a", { method: "DELETE", body: { confirmation: "stroke-a" } })).status, 400);
  assert.equal((await request("/strokes/stroke-a", { method: "DELETE", body: { confirmation: "stroke-a", roomId: "room-a" } })).status, 200);
  assert.deepEqual(events, [["room-a", "room-stroke-deleted", { roomId: "room-a", strokeId: "stroke-a" }]]);
});
test("stroke style validation rejects invalid values and preserves coordinates", async (t) => {
  const { request, events } = await fixture(t, (db) => {
    db.wallStroke.update = async ({ where, data }) => {
      assert.deepEqual(where, { id: "stroke-a", roomId: "room-a" });
      assert.deepEqual(data, { color: "#aabbcc", size: 6 });
      return { id: "stroke-a", roomId: "room-a", ...data, points: [{ x: 2, y: 3 }] };
    };
  });
  assert.equal((await request("/strokes/stroke-a", { method: "PATCH", body: { roomId: "room-a", color: "red", size: 999 } })).status, 400);
  assert.equal((await request("/strokes/stroke-a", { method: "PATCH", body: { roomId: "room-a", color: "#aabbcc", size: 6, points: [] } })).status, 200);
  assert.deepEqual(events[0][2].points, [{ x: 2, y: 3 }]);
});

test("message management rejects ordinary users for reads and writes", async (t) => {
  const { request } = await fixture(t);
  for (const [path, method] of [["/messages", "GET"], ["/messages/id", "PATCH"], ["/messages/id", "DELETE"]]) {
    assert.equal((await request(path, { actor: null, method })).status, 401);
    assert.equal((await request(path, { actor: user, method })).status, 403);
  }
});

test("message search combines room scope, content search and pagination", async (t) => {
  let listWhere;
  const { request } = await fixture(t, (db) => {
    db.chatMessage.findMany = async ({ where, skip, take, select }) => {
      listWhere = where;
      assert.equal(where.roomId, "room-a");
      assert.equal(where.OR[2].content.contains, "hello");
      assert.equal(skip, 25);
      assert.equal(take, 25);
      assert.deepEqual(select.author, { select: { email: true } });
      return [{ id: "message-a", content: "hello world" }];
    };
    db.chatMessage.count = async ({ where }) => {
      assert.deepEqual(where, listWhere);
      return 26;
    };
  });
  const result = await request("/messages?roomId=room-a&q=hello&page=2");
  assert.equal(result.status, 200);
  assert.equal(result.data.data.total, 26);
  assert.equal(result.data.data.items[0].content, "hello world");
  assert.equal((await request("/messages?page=0")).status, 400);
});

test("message editing validates content and preserves author and room", async (t) => {
  const { request, events, audit } = await fixture(t, (db) => {
    db.chatMessage.update = async ({ where, data }) => {
      assert.deepEqual(where, { id: "message-a", roomId: "room-a" });
      assert.deepEqual(data, { content: "updated\nmessage" });
      return { id: "message-a" };
    };
  });
  for (const content of ["  ", "a".repeat(1001), 123]) {
    assert.equal((await request("/messages/message-a", {
      method: "PATCH", body: { roomId: "room-a", content },
    })).status, 400);
  }
  assert.deepEqual(events, []);
  const result = await request("/messages/message-a", {
    method: "PATCH", body: { roomId: "room-a", content: " updated\nmessage ", authorId: admin },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(events, [["room-a", "room-content-changed", { roomId: "room-a" }]]);
  assert.equal(audit[0].action, "message.update");
});

test("message deletion requires confirmation and the matching room", async (t) => {
  const { request, events, audit } = await fixture(t, (db) => {
    db.chatMessage.deleteMany = async ({ where }) => {
      assert.equal(where.id, "message-a");
      return { count: where.roomId === "room-a" ? 1 : 0 };
    };
  });
  assert.equal((await request("/messages/message-a", {
    method: "DELETE", body: { roomId: "room-a" },
  })).status, 400);
  assert.equal((await request("/messages/message-a", {
    method: "DELETE", body: { roomId: "room-b", confirmation: "message-a" },
  })).status, 404);
  assert.deepEqual(events, []);
  assert.deepEqual(audit, []);
  assert.equal((await request("/messages/message-a", {
    method: "DELETE", body: { roomId: "room-a", confirmation: "message-a" },
  })).status, 200);
  assert.deepEqual(events, [["room-a", "room-content-changed", { roomId: "room-a" }]]);
  assert.equal(audit[0].action, "message.delete");
});
