import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import App from "../src/App";

test("empty production household renders real zero balances and onboarding actions without sample data", () => {
  const html = renderToStaticMarkup(
    <App
      initialData={{
        household: {
          name: "Test household",
          currency: "EUR",
          starting_funds: 0,
          demo: false,
        },
        accounts: [],
        categories: [],
        targets: [],
        allocations: [],
        transactions: [],
        profiles: [],
        batches: [],
        reconciliations: [],
      }}
    />,
  );
  assert.match(html, /What are you making room for/);
  assert.match(html, /Create an envelope/);
  assert.match(html, /Add a transaction/);
  assert.match(html, /€0\.00/);
  assert.doesNotMatch(html, /DEVELOPMENT DEMO|The corner market|Sunday coffee/);
  assert.match(html, /aria-current="page"/);
});
