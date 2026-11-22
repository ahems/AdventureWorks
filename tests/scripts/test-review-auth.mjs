import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

const ts = createRequire(new URL("../../app/package.json", import.meta.url))("typescript");
const user = { id: "customer-7", businessEntityId: 7, email: "shopper@example.test" };
const submission = { productId: 1, userName: "Shopper", rating: 5, title: "Good", comment: "A useful product." };

async function loadReviews({ authenticated = true, reviews = [], status = 200,
  response = { value: [{ ProductReviewID: 99 }] },
  voteStatus = 200, voteResponse = { productReviewId: 99, helpfulVotes: 1, voted: true, changed: true },
  voteError = false } = {}) {
  const calls = [];
  const errors = [];
  const storage = new Map();
  const updates = [];
  let stateIndex = 0;
  const context = vm.createContext({
    Date, localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
  });
  const dependencies = {
    react: {
      useState: () => [stateIndex++ === 0 ? reviews : false, (value) => updates.push(value)],
      useEffect: () => {},
    },
    "@tanstack/react-query": { useQuery: () => ({}) },
    "@/context/AuthContext": { useAuth: () => ({ isAuthenticated: authenticated, user: authenticated ? user : null }) },
    "@/lib/graphql-client": { graphqlClient: { request: async (query, variables) => {
      calls.push({ query, variables });
      throw new Error("Unexpected GraphQL request");
    } } },
    "@/lib/graphql-queries": { GET_PRODUCT_REVIEWS: "", GET_ALL_REVIEWS: "" },
    "@/lib/graphql-pagination": { fetchAllPages: async () => [] },
    "@/lib/utils": {
      getRestApiUrl: () => "https://dab.example.test/api",
      getFunctionsApiUrl: () => "https://functions.example.test",
    },
    "@/services/functionsAuth": {
      functionsFetch: async (url, options) => {
        calls.push({ url, options, functions: true });
        if (voteError) throw new Error("Functions request failed");
        return new Response(JSON.stringify(voteResponse), { status: voteStatus });
      },
    },
    "@/lib/dabFetch": {
      dabFetch: async (url, options) => {
        calls.push({ url, options });
        return new Response(JSON.stringify(response), { status });
      },
    },
    "@/lib/appInsights": { trackError: (...args) => errors.push(args) },
  };
  const source = ts.transpileModule(
    await readFile(new URL("../../app/src/hooks/useReviews.ts", import.meta.url), "utf8"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
  ).outputText;
  const module = new vm.SourceTextModule(source, { context });
  await module.link(async (name) => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
    const exports = dependencies[name];
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  return { hook: module.namespace.useReviews(1), calls, errors, storage, updates };
}

test("anonymous submissions never create API or local-storage reviews", async () => {
  const { hook, calls, storage, errors } = await loadReviews({ authenticated: false });
  await assert.rejects(hook.addReview(submission, user.email, user.businessEntityId), /sign in/);
  assert.equal(calls.length, 0);
  assert.equal(storage.size, 0);
  assert.equal(errors.length, 1);
});

test("anonymous likes are rejected for API and legacy local reviews", async () => {
  for (const id of ["api_99", "user_99"]) {
    const { hook, calls, storage, errors } = await loadReviews({ authenticated: false });
    await assert.rejects(hook.markAsUseful(id, user.id), /sign in/);
    assert.equal(calls.length, 0);
    assert.equal(storage.size, 0);
    assert.equal(errors.length, 1);
  }
});

test("review authorship and voting identity must match the current session", async () => {
  const { hook, calls } = await loadReviews();
  await assert.rejects(hook.addReview(submission, "other@example.test", 9), /sign in/);
  await assert.rejects(hook.addReview(submission), /sign in/);
  await assert.rejects(hook.markAsUseful("api_99", "other-user"), /sign in/);
  assert.equal(calls.length, 0);
});

test("authenticated creation sends its owner and leaves privileged fields to the server", async () => {
  const { hook, calls } = await loadReviews();
  const result = await hook.addReview(submission, user.email, user.businessEntityId);
  assert.equal(result.id, "api_99");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "POST");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.UserID, user.businessEntityId);
  assert.equal(body.EmailAddress, user.email);
  for (const field of ["HelpfulVotes", "IsModerated", "CommentsEmbedding", "ModifiedDate"]) {
    assert.equal(Object.hasOwn(body, field), false);
  }
});

test("HTTP errors or missing persisted review IDs cannot become submission success", async () => {
  for (const options of [{ status: 403 }, { response: {} }, { response: { value: [{ ProductReviewID: "99" }] } }]) {
    const { hook, updates, errors } = await loadReviews(options);
    await assert.rejects(hook.addReview(submission, user.email, user.businessEntityId),
      /Failed to submit|no valid review identifier/);
    assert.equal(updates.length, 0);
    assert.equal(errors.length, 1);
  }
});

test("authenticated voting uses the one-vote-per-user Functions route and refuses self-votes", async () => {
  const otherReview = { id: "api_99", userID: 8, helpful: 0 };
  const { hook, calls, updates } = await loadReviews({ reviews: [otherReview] });
  assert.equal(await hook.markAsUseful(otherReview.id, user.id), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].functions, true);
  assert.equal(calls[0].url, "https://functions.example.test/api/reviews/99/vote");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.body, undefined);
  assert.equal(updates.length, 1);
  const own = await loadReviews({ reviews: [{ ...otherReview, userID: user.businessEntityId }] });
  assert.equal(await own.hook.markAsUseful(otherReview.id, user.id), false);
  assert.equal(own.calls.length, 0);
});

test("a second click removes the user's vote through the same route", async () => {
  const review = { id: "api_99", userID: 8, helpful: 1 };
  const { hook, calls, storage } = await loadReviews({
    reviews: [review],
    voteResponse: { productReviewId: 99, helpfulVotes: 0, voted: false, changed: true },
  });
  storage.set("adventureworks_user_reviews_votes", JSON.stringify({ api_99: [user.id] }));
  assert.equal(await hook.markAsUseful(review.id, user.id), true);
  assert.equal(calls[0].options.method, "DELETE");
  assert.deepEqual(JSON.parse(storage.get("adventureworks_user_reviews_votes")), { api_99: [] });
});

test("failed or unconfirmed votes do not update local state", async () => {
  const review = { id: "api_99", userID: 8, helpful: 0 };
  for (const options of [{ voteError: true }, { voteStatus: 403 }, { voteStatus: 404 },
    { voteResponse: { productReviewId: 100, helpfulVotes: 1, voted: true } },
    { voteResponse: { productReviewId: 99, helpfulVotes: "1", voted: true } },
    { voteResponse: { productReviewId: 99, helpfulVotes: 0, voted: false } }]) {
    const { hook, storage, updates, errors } = await loadReviews({ ...options, reviews: [review] });
    assert.equal(await hook.markAsUseful(review.id, user.id), false);
    assert.equal(storage.size, 0);
    assert.equal(updates.length, 0);
    assert.equal(errors.length, 1);
  }
});

test("public review queries omit email while retaining author IDs for self-vote checks", async () => {
  const source = await readFile(new URL("../../app/src/lib/graphql-queries.ts", import.meta.url), "utf8");
  const file = ts.createSourceFile("graphql-queries.ts", source, ts.ScriptTarget.Latest, true);
  const queries = new Map();
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
        node.initializer && ts.isTaggedTemplateExpression(node.initializer)) {
      queries.set(node.name.text, node.initializer.template.getText(file));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  for (const name of ["GET_PRODUCT_REVIEWS", "GET_ALL_REVIEWS"]) {
    assert.ok(queries.has(name));
    assert.doesNotMatch(queries.get(name), /\bEmailAddress\b/);
    assert.match(queries.get(name), /\bUserID\b/);
  }
});
