import "dotenv/config";
import passport from "passport";
import { Strategy as GoogleStrategy, Profile } from "passport-google-oauth20";
import session from "express-session";
import connectPg from "connect-pg-simple";
import type { Express, RequestHandler } from "express";
import { storage } from "./storage";

/**
 * Re-usable Postgres-backed session store
 */
function getSession() {
  const sessionTtlMs = 7 * 24 * 60 * 60 * 1000; // 1 week
  const pgStore = connectPg(session);
  const sessionStore = new pgStore({
    conString: process.env.DATABASE_URL,
    createTableIfMissing: true,
    ttl: sessionTtlMs,
    tableName: "sessions",
  });

  return session({
    secret: process.env.SESSION_SECRET ?? "change-me",
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure:
        process.env.COOKIE_SECURE
          ? process.env.COOKIE_SECURE === "true"
          : process.env.NODE_ENV === "production",
      maxAge: sessionTtlMs,
      sameSite: "lax",
    },
    rolling: true,
  });
}

/**
 * Map Google profile to our user schema and upsert
 */
async function upsertUser(profile: Profile) {
  const email = profile.emails?.[0]?.value;
  const photo = profile.photos?.[0]?.value;

  await storage.upsertUser({
    id: profile.id,
    email,
    firstName: profile.name?.givenName,
    lastName: profile.name?.familyName,
    profileImageUrl: photo,
  });
}

export async function setupAuth(app: Express) {
  app.set("trust proxy", 1);
  app.use(getSession());
  app.use(passport.initialize());
  app.use(passport.session());

  const clientID = process.env.GOOGLE_CLIENT_ID as string;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET as string;
  const callbackURL = process.env.GOOGLE_CALLBACK_URL as string;

  if (!clientID || !clientSecret || !callbackURL) {
    throw new Error("Google OAuth environment variables are not set correctly");
  }

  passport.use(
    new GoogleStrategy(
      {
        clientID,
        clientSecret,
        callbackURL,
      },
      async (accessToken: string, refreshToken: string, profile: Profile, cb) => {
        const email = profile.emails?.[0]?.value;
        const photo = profile.photos?.[0]?.value;
        try {
          await upsertUser(profile);
          const user = {
            claims: {
              sub: profile.id,
              first_name: profile.name?.givenName,
              last_name: profile.name?.familyName,
              email,
              profile_image_url: photo,
            },
            access_token: accessToken,
            refresh_token: refreshToken,
          } as any;
          return cb(null, user);
        } catch (err) {
          return cb(err as Error);
        }
      },
    ),
  );

  passport.serializeUser((user: Express.User, done) => done(null, user));
  passport.deserializeUser((user: Express.User, done) => done(null, user));

  // Routes
  app.get("/api/login", passport.authenticate("google", { scope: ["profile", "email"], prompt: "select_account" }));
  app.get(
    "/api/callback",
    passport.authenticate("google", {
      successReturnToOrRedirect: "/",
      failureRedirect: "/api/login",
    }),
  );
  app.get("/api/logout", (req, res) => {
    req.logout(() => {
      res.redirect("/");
    });
  });
}

export const isAuthenticated: RequestHandler = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  return res.status(401).json({ message: "Unauthorized" });
};
