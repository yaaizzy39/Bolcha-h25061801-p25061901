import {
  pgTable,
  text,
  varchar,
  timestamp,
  jsonb,
  index,
  serial,
  integer,
  boolean,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Session storage table for Replit Auth
export const sessions = pgTable(
  "sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire").notNull(),
  },
  (table) => [index("IDX_session_expire").on(table.expire)],
);

// User storage table for Replit Auth
export const users = pgTable("users", {
  id: varchar("id").primaryKey().notNull(),
  email: varchar("email").unique(),
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  profileImageUrl: varchar("profile_image_url"),
  customProfileImageUrl: varchar("custom_profile_image_url"),
  useCustomProfileImage: boolean("use_custom_profile_image").default(false),
  preferredLanguage: varchar("preferred_language").default("ja"),
  interfaceLanguage: varchar("interface_language").default("ja"),
  showOriginalText: boolean("show_original_text").default(true),
  autoTranslate: boolean("auto_translate").default(true),
  messageAlignment: varchar("message_alignment").default("right"),
  isAdmin: boolean("is_admin").default(false),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Chat rooms table
export const chatRooms = pgTable("chat_rooms", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  createdBy: varchar("created_by").notNull().references(() => users.id),
  adminOnly: boolean("admin_only").default(false),
  createdAt: timestamp("created_at").defaultNow(),
  lastActivity: timestamp("last_activity").defaultNow(),
  isActive: boolean("is_active").default(true),
});

// Messages table for chat history
export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  roomId: integer("room_id").notNull().references(() => chatRooms.id, { onDelete: "cascade" }),
  senderId: varchar("sender_id").notNull().references(() => users.id),
  senderName: varchar("sender_name").notNull(),
  senderProfileImageUrl: varchar("sender_profile_image_url"),
  originalText: text("original_text").notNull(),
  translatedText: text("translated_text"),
  originalLanguage: varchar("original_language").notNull(),
  replyToId: integer("reply_to_id"),
  replyToText: text("reply_to_text"),
  replyToSenderName: varchar("reply_to_sender_name"),
  mentions: text("mentions").array(),
  timestamp: timestamp("timestamp").defaultNow(),
});

// Likes table for message reactions
export const messageLikes = pgTable("message_likes", {
  id: serial("id").primaryKey(),
  messageId: integer("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  userId: varchar("user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at").defaultNow(),
});

export const translationApis = pgTable("translation_apis", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  url: text("url").notNull(),
  isActive: boolean("is_active").default(true),
  priority: integer("priority").default(1), // Lower numbers = higher priority
  lastUsed: timestamp("last_used"),
  errorCount: integer("error_count").default(0),
  successCount: integer("success_count").default(0),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertUserSchema = createInsertSchema(users).omit({
  createdAt: true,
  updatedAt: true,
});

export const insertChatRoomSchema = createInsertSchema(chatRooms).omit({
  id: true,
  createdAt: true,
  lastActivity: true,
  isActive: true,
});

export const insertMessageSchema = createInsertSchema(messages).omit({
  id: true,
  timestamp: true,
  senderProfileImageUrl: true,
  translatedText: true,
});

export const insertMessageLikeSchema = createInsertSchema(messageLikes).omit({
  id: true,
  createdAt: true,
});

export const insertTranslationApiSchema = createInsertSchema(translationApis).omit({
  id: true,
  lastUsed: true,
  errorCount: true,
  successCount: true,
  createdAt: true,
  updatedAt: true,
});

export type UpsertUser = typeof users.$inferInsert;
export type User = typeof users.$inferSelect;
export type InsertChatRoom = z.infer<typeof insertChatRoomSchema>;
export type ChatRoom = typeof chatRooms.$inferSelect;
export type InsertMessage = z.infer<typeof insertMessageSchema>;
export type Message = typeof messages.$inferSelect;
export type InsertMessageLike = z.infer<typeof insertMessageLikeSchema>;
export type MessageLike = typeof messageLikes.$inferSelect;
export type InsertTranslationApi = z.infer<typeof insertTranslationApiSchema>;
export type TranslationApi = typeof translationApis.$inferSelect;
