import { collection } from "../config/db.js";
import { env } from "../config/env.js";
import { ApiError } from "../middleware/error.js";

/**
 * PATCH /api/profile — update the caller's own profile. Role, blocking and
 * subscription fields are deliberately NOT accepted here; those are admin-only
 * (see routes/admin.js), so a customer cannot self-promote.
 */
export async function updateProfile(req, res, next) {
  try {
    const { name, image, bio, phone, businessName } = req.body || {};
    const updates = { updatedAt: new Date() };

    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (!trimmed) throw new ApiError(400, "Name cannot be empty.");
      updates.name = trimmed;
    }
    if (image !== undefined) updates.image = image === "" ? "" : String(image);
    if (bio !== undefined) updates.bio = String(bio);
    if (phone !== undefined) updates.phone = String(phone);
    if (businessName !== undefined) updates.businessName = String(businessName);

    const user = await collection("user").findOneAndUpdate(
      { _id: req.user._id },
      { $set: updates },
      { returnDocument: "after", projection: { password: 0 } },
    );
    if (!user) throw new ApiError(404, "Account no longer exists.");
    res.json({ user });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/profile/image — uploads a base64 image to ImgBB and returns the
 * hosted URL. Requires IMGBB_API_KEY; returns 503 with a clear message if the
 * key has not been added yet (per the env-only secrets rule).
 */
export async function uploadImage(req, res, next) {
  try {
    if (!env.imgbbApiKey) {
      throw new ApiError(
        503,
        "Image uploads are not configured yet (IMGBB_API_KEY missing in .env).",
      );
    }

    const { imageBase64 } = req.body || {};
    if (!imageBase64 || typeof imageBase64 !== "string") {
      throw new ApiError(400, "imageBase64 is required.");
    }

    // Accept raw base64 or a full data: URL.
    const base64 = imageBase64.replace(/^data:image\/\w+;base64,/, "");
    if (base64.length > 4 * 1024 * 1024) {
      throw new ApiError(413, "Image must be smaller than 4 MB.");
    }

    const form = new FormData();
    form.append("image", base64);

    const response = await fetch(
      `https://api.imgbb.com/1/upload?key=${env.imgbbApiKey}`,
      { method: "POST", body: form },
    );
    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.success) {
      console.error("ImgBB upload failed:", data);
      throw new ApiError(502, "Image upload failed. Please try again.");
    }

    res.json({ url: data.data.url, displayUrl: data.data.display_url });
  } catch (err) {
    next(err);
  }
}
