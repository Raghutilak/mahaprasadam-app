// ══════════════════════════════════════════════════════════════════
// admin-staff-management
//
// Privileged staff-management operations.
// This function runs on Supabase infrastructure, never in the browser.
//
// The browser sends the currently logged-in staff member's access token.
// This function verifies that token and requires:
//
//     auth.users.app_metadata.role === "admin"
//
// Only then are privileged Auth/database operations performed.
//
// Actions:
//   • reset-password
//       { staffId, newPassword }
//
//   • add-staff
//       { name, email, mobile, password, allowedTabs, restrictReportsToToday }
//
//   • update-role
//       { staffId, role }
//
// IMPORTANT:
// - Never put a secret/service-role key in frontend code.
// - Never store staff passwords in public.staff_users.
// - Authorization is enforced here, not by frontend UI checks.
// ══════════════════════════════════════════════════════════════════

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.115.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");

function getSecretKey() {
  const secretKeysRaw = Deno.env.get("SUPABASE_SECRET_KEYS");

  if (secretKeysRaw) {
    try {
      const keys = JSON.parse(secretKeysRaw);

      if (keys && typeof keys === "object") {
        const key = keys.default || Object.values(keys)[0];

        if (typeof key === "string" && key.length > 0) {
          return key;
        }
      }
    } catch {
      // Fall through to legacy service-role key.
    }
  }

  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
}

const SECRET_KEY = getSecretKey();

// Restrict CORS to your actual deployed frontend — set ALLOWED_ORIGIN as a
// Supabase secret (e.g. https://your-app.vercel.app). Falls back to a
// same-origin-only default (no wildcard) if unset, so an unconfigured
// deployment fails closed rather than silently staying wide open.
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") || "https://sweet-accounts.vercel.app";

const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;

  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }

  return "Something went wrong.";
}

if (!SUPABASE_URL || !SECRET_KEY) {
  console.error(
    "Missing SUPABASE_URL or privileged Supabase secret key."
  );
}

Deno.serve(async (req) => {
  // ── CORS preflight ────────────────────────────────────────────────
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed." }, 405);
  }

  // Do not attempt privileged operations if the function itself
  // is missing its server-side configuration.
  if (!SUPABASE_URL || !SECRET_KEY) {
    return json(
      { error: "Server configuration is incomplete." },
      500
    );
  }

  // ── Privileged Supabase client ────────────────────────────────────
  // This client exists only inside the Edge Function.
  const admin = createClient(SUPABASE_URL, SECRET_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  // ── Verify caller's access token ─────────────────────────────────
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();

  if (!token) {
    return json({ error: "Missing Authorization header." }, 401);
  }

  const {
    data: callerData,
    error: callerErr,
  } = await admin.auth.getUser(token);

  if (callerErr || !callerData?.user) {
    return json({ error: "Invalid or expired session." }, 401);
  }

  const caller = callerData.user;
  const callerRole = caller.app_metadata?.role;

  // IMPORTANT:
  // app_metadata is the authoritative source for privileged
  // authorization. Do not fall back to public.staff_users.role here.
  if (callerRole !== "admin") {
    return json({ error: "Only an admin can do this." }, 403);
  }

  // ── Parse request ─────────────────────────────────────────────────
  let body: Record<string, unknown>;

  try {
    const parsed = await req.json();

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return json({ error: "Invalid JSON body." }, 400);
    }

    body = parsed as Record<string, unknown>;
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  const action = body.action;

  if (typeof action !== "string") {
    return json({ error: "An action is required." }, 400);
  }

  try {
    // ════════════════════════════════════════════════════════════════
    // RESET PASSWORD
    // ════════════════════════════════════════════════════════════════
    if (action === "reset-password") {
      const staffId = body.staffId;
      const newPassword = body.newPassword;

      if (typeof staffId !== "string" || !staffId.trim()) {
        return json({ error: "staffId is required." }, 400);
      }

      if (typeof newPassword !== "string" || !newPassword) {
        return json({ error: "newPassword is required." }, 400);
      }

      // Server-side password policy.
      if (newPassword.length < 8) {
        return json(
          { error: "Password must be at least 8 characters long." },
          400
        );
      }

      if (newPassword.length > 128) {
        return json(
          { error: "Password is too long." },
          400
        );
      }

      // Verify that the target is actually a staff profile.
      const {
        data: targetProfile,
        error: targetProfileErr,
      } = await admin
        .from("staff_users")
        .select("id, role")
        .eq("id", staffId.trim())
        .maybeSingle();

      if (targetProfileErr) {
        throw targetProfileErr;
      }

      if (!targetProfile) {
        return json(
          { error: "That account is not a staff profile." },
          404
        );
      }

      const {
        error: passwordErr,
      } = await admin.auth.admin.updateUserById(staffId.trim(), {
        password: newPassword,
      });

      if (passwordErr) {
        throw passwordErr;
      }

      return json({ ok: true });
    }

    // ════════════════════════════════════════════════════════════════
    // ADD STAFF
    // ════════════════════════════════════════════════════════════════
    if (action === "add-staff") {
      const name =
        typeof body.name === "string" ? body.name.trim() : "";

      const email =
        typeof body.email === "string"
          ? body.email.trim().toLowerCase()
          : "";

      const mobile =
        typeof body.mobile === "string"
          ? body.mobile.trim()
          : "";

      const password =
        typeof body.password === "string"
          ? body.password
          : "";

      const allowedTabs = Array.isArray(body.allowedTabs)
        ? body.allowedTabs.filter(
            (tab): tab is string => typeof tab === "string"
          )
        : [];

      const restrictReportsToToday =
        body.restrictReportsToToday === true;

      if (!name) {
        return json({ error: "name is required." }, 400);
      }

      if (name.length > 200) {
        return json({ error: "Name is too long." }, 400);
      }

      if (!email) {
        return json({ error: "email is required." }, 400);
      }

      if (email.length > 320 || !email.includes("@")) {
        return json({ error: "A valid email is required." }, 400);
      }

      if (!password) {
        return json({ error: "password is required." }, 400);
      }

      if (password.length < 8) {
        return json(
          { error: "Password must be at least 8 characters long." },
          400
        );
      }

      if (password.length > 128) {
        return json({ error: "Password is too long." }, 400);
      }

      // Create the Auth account first.
      const {
        data: created,
        error: createErr,
      } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        app_metadata: {
          role: "staff",
        },
      });

      if (createErr || !created?.user) {
        throw createErr || new Error("Could not create Auth user.");
      }

      const newUserId = created.user.id;

      // Then create the matching staff profile.
      const {
        data: profile,
        error: profileErr,
      } = await admin
        .from("staff_users")
        .insert({
          id: newUserId,
          name,
          email,
          mobile: mobile || null,
          role: "staff",
          allowed_tabs: allowedTabs,
          restrict_reports_to_today: restrictReportsToToday,
        })
        .select()
        .single();

      // If profile creation fails, remove the Auth account we just
      // created so we don't leave an orphaned login behind.
      if (profileErr || !profile) {
        const { error: cleanupErr } =
          await admin.auth.admin.deleteUser(newUserId);

        if (cleanupErr) {
          console.error(
            "Profile creation failed and Auth-user cleanup also failed:",
            cleanupErr.message
          );
        }

        throw profileErr || new Error("Could not create staff profile.");
      }

      return json({
        ok: true,
        staff: profile,
      });
    }

    // ════════════════════════════════════════════════════════════════
    // UPDATE ROLE
    // ════════════════════════════════════════════════════════════════
    if (action === "update-role") {
      const staffId =
        typeof body.staffId === "string"
          ? body.staffId.trim()
          : "";

      const role = body.role;

      if (!staffId) {
        return json({ error: "staffId is required." }, 400);
      }

      if (role !== "admin" && role !== "staff") {
        return json(
          { error: "role must be either admin or staff." },
          400
        );
      }

      // Prevent an admin from accidentally removing their own
      // administrative access through this endpoint.
      if (staffId === caller.id) {
        return json(
          {
            error:
              "You cannot change your own role from this screen.",
          },
          403
        );
      }

      // Verify target is a staff profile.
      const {
        data: targetProfile,
        error: targetProfileErr,
      } = await admin
        .from("staff_users")
        .select("id, role")
        .eq("id", staffId)
        .maybeSingle();

      if (targetProfileErr) {
        throw targetProfileErr;
      }

      if (!targetProfile) {
        return json(
          { error: "That account is not a staff profile." },
          404
        );
      }

      // If demoting an admin, make sure at least one other admin
      // remains. This prevents accidentally locking the system
      // out of its admin-management functions.
      if (targetProfile.role === "admin" && role === "staff") {
        const {
          count: adminCount,
          error: adminCountErr,
        } = await admin
          .from("staff_users")
          .select("id", {
            count: "exact",
            head: true,
          })
          .eq("role", "admin");

        if (adminCountErr) {
          throw adminCountErr;
        }

        if ((adminCount ?? 0) <= 1) {
          return json(
            {
              error:
                "The last admin cannot be changed to staff. Create another admin first.",
            },
            409
          );
        }
      }

      // Fetch the current Auth user so we preserve any existing
      // app_metadata instead of replacing unrelated metadata.
      const {
        data: targetAuthData,
        error: targetAuthErr,
      } = await admin.auth.admin.getUserById(staffId);

      if (targetAuthErr || !targetAuthData?.user) {
        throw targetAuthErr || new Error("Auth user not found.");
      }

      const existingMetadata =
        targetAuthData.user.app_metadata || {};

      // Auth metadata is the authoritative authorization source.
      const {
        error: metaErr,
      } = await admin.auth.admin.updateUserById(staffId, {
        app_metadata: {
          ...existingMetadata,
          role,
        },
      });

      if (metaErr) {
        throw metaErr;
      }

      // Keep the profile role synchronized for display/management.
      const {
        error: rowErr,
      } = await admin
        .from("staff_users")
        .update({ role })
        .eq("id", staffId);

      if (rowErr) {
        // The Auth role has already changed. Log the inconsistency
        // so it can be investigated rather than silently hiding it.
        console.error(
          "Auth role changed but staff_users role update failed:",
          rowErr.message
        );

        throw rowErr;
      }

      return json({ ok: true });
    }

    // ════════════════════════════════════════════════════════════════
    // UNKNOWN ACTION
    // ════════════════════════════════════════════════════════════════
    return json(
      { error: `Unknown action: ${action}` },
      400
    );
  } catch (err) {
    console.error(`admin-staff-management ${action} failed:`, err);

    return json(
      {
        error: errorMessage(err),
      },
      500
    );
  }
});
