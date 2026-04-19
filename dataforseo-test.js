/**
 * dataforseo-test.js — sanity check credentials & connection
 *
 * Hits DataForSEO's account status endpoint. If this works, auth is good
 * and we know how much credit is on the account.
 *
 * USAGE:
 *   railway run node dataforseo-test.js
 */

const LOGIN = process.env.DATAFORSEO_LOGIN;
const PASSWORD = process.env.DATAFORSEO_PASSWORD;

if (!LOGIN || !PASSWORD) {
  console.error("✗ Missing DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD env vars.");
  console.error("  Run via: railway run node dataforseo-test.js");
  process.exit(1);
}

const AUTH = "Basic " + Buffer.from(`${LOGIN}:${PASSWORD}`).toString("base64");

async function main() {
  console.log("── DataForSEO credential test ──\n");

  try {
    const res = await fetch("https://api.dataforseo.com/v3/appendix/user_data", {
      method: "GET",
      headers: { Authorization: AUTH, Accept: "application/json" },
    });

    const body = await res.text();

    if (!res.ok) {
      console.error(`✗ HTTP ${res.status} ${res.statusText}`);
      console.error(body.slice(0, 500));
      process.exit(1);
    }

    const data = JSON.parse(body);

    if (data.status_code !== 20000) {
      console.error(`✗ API error: ${data.status_code} — ${data.status_message}`);
      process.exit(1);
    }

    const user = data.tasks?.[0]?.result?.[0];
    if (!user) {
      console.log("✓ Auth OK, but user data response was unexpected shape:");
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    console.log(`✓ Authenticated as ${user.login || LOGIN}`);
    console.log(`  Account:       ${user.login}`);
    console.log(`  Tier:          ${user.tier || "—"}`);
    console.log(`  Money balance: $${user.money?.balance ?? "unknown"}`);
    console.log(`  Timezone:      ${user.timezone || "—"}`);
    console.log(`  Rate limits:   ${user.rates?.limits_per_minute ?? "—"} req/min`);

    if (user.money?.balance === 0) {
      console.log("\n⚠️  Balance is $0 — you likely need to make the minimum deposit");
      console.log("   before live API calls will work. Sandbox calls may still work.");
    } else if (user.money?.balance < 5) {
      console.log(`\n⚠️  Balance is low ($${user.money.balance}) — consider topping up.`);
    } else {
      console.log(`\n✓ Balance is healthy. Ready to run the refresh script.`);
    }
  } catch (e) {
    console.error("✗ Request failed:", e.message);
    process.exit(1);
  }
}

main();
