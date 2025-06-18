import { Express, Request, Response, NextFunction } from "express";
import { Server, createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { storage } from "./storage.js";
import { isAuthenticated, setupAuth } from "./googleAuth.js";
import type { InsertMessage, InsertChatRoom } from "../shared/schema.js";
import { broadcastToAll, broadcastToRoom, getOnlineUserCount, broadcastOnlineCount } from "./ws_helpers";

interface AuthenticatedUser {
  claims: {
    sub: string;
    email?: string;
    first_name?: string;
    last_name?: string;
    profile_image_url?: string;
  };
}

export interface WebSocketClient extends WebSocket {
  userId?: string;
  userName?: string;
  roomId?: number;
}

async function translateText(text: string, source: string, target: string): Promise<string> {
  console.log(`Translation request: "${text}" (${source} -> ${target})`);
  
  if (source === target) {
    return text;
  }

  try {
    // Get active translation APIs ordered by priority
    const apis = await storage.getActiveTranslationApis();
    
    if (apis.length === 0) {
      console.log('No active translation APIs configured');
      return text;
    }

    // Try each API in priority order
    for (const api of apis) {
      try {
        console.log(`Trying API: ${api.name} (${api.url})`);
        
        let response;
        
        try {
          // Try GET request first
          const params = new URLSearchParams({
            text: text,
            source: source,
            target: target
          });
          
          response = await fetch(`${api.url}?${params}`, {
            method: 'GET',
            headers: {
              'Accept': 'application/json',
            }
          });
          
          if (!response.ok) {
            throw new Error(`GET request failed: ${response.status}`);
          }
        } catch (error) {
          // If GET fails, try POST
          response = await fetch(api.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              text: text,
              source: source,
              target: target
            })
          });
        }

        if (response.ok) {
          const responseText = await response.text();
          console.log(`API ${api.name} response: ${responseText.substring(0, 100)}...`);
          
          try {
            const data = JSON.parse(responseText);
            // Check for various response formats
            const translatedText = data.translatedText || data.text || data.result;
            if (translatedText && translatedText !== text && data.code === 200) {
              console.log(`API ${api.name} translation: "${text}" -> "${translatedText}"`);
              await storage.updateApiStats(api.id, true);
              return translatedText;
            }
          } catch (parseError) {
            console.log(`API ${api.name} response not JSON: ${responseText.substring(0, 100)}...`);
          }
        } else {
          console.log(`API ${api.name} request failed with status: ${response.status}`);
        }
        
        // Mark this API as having an error
        await storage.updateApiStats(api.id, false);
        
      } catch (apiError) {
        console.log(`API ${api.name} failed:`, apiError);
        await storage.updateApiStats(api.id, false);
      }
    }

    console.log(`No translation available for: "${text}"`);
    return text;
  } catch (error) {
    console.error('Translation error:', error);
    return text;
  }
}

// No local translation - return original text when translation service fails
function getSimpleTranslation(text: string, target: string): string {
  console.log(`Translation service failed for: "${text}"`);
  return text;
}

// Enhanced language detection function
function detectLanguage(text: string): string {
  // Language detection patterns
  const patterns: Record<string, RegExp> = {
    'ja': /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/,  // Japanese
    'ko': /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/,  // Korean
    'zh': /[\u4E00-\u9FFF]/,                              // Chinese
    'ar': /[\u0600-\u06FF\u0750-\u077F]/,                // Arabic
    'hi': /[\u0900-\u097F]/,                             // Hindi
    'th': /[\u0E00-\u0E7F]/,                             // Thai
    'vi': /[àáảãạâầấẩẫậăằắẳẵặèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i,
    'ru': /[\u0400-\u04FF]/,                             // Russian
    'es': /[ñáéíóúü]/i,                                  // Spanish
    'fr': /[àâäçéèêëïîôùûüÿ]/i,                          // French
    'de': /[äöüßÄÖÜ]/,                                   // German
    'pt': /[ãâáàçêéíôóõúü]/i,                            // Portuguese
    'it': /[àèéìíîòóù]/i,                                // Italian
    'nl': /[äëïöüÄËÏÖÜ]/,                                // Dutch
  };

  // Check for non-Latin scripts first
  for (const [lang, pattern] of Object.entries(patterns)) {
    if (pattern.test(text)) {
      return lang;
    }
  }

  // Default to English for basic Latin text
  return 'en';
}

// Extract mentions from message text
function extractMentions(text: string): string[] {
  const mentionPattern = /@(\w+)/g;
  const mentions: string[] = [];
  let match;
  
  while ((match = mentionPattern.exec(text)) !== null) {
    mentions.push(match[1]);
  }
  
  return Array.from(new Set(mentions));
}

export default async function registerRoutes(app: Express): Promise<Server> {
  // Admin check middleware
  const requireAdmin = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user as AuthenticatedUser;
      const userData = await storage.getUser(user.claims.sub);
      if (!userData?.isAdmin) {
        return res.status(403).json({ error: 'Admin access required' });
      }
      next();
    } catch (error) {
      res.status(500).json({ error: 'Failed to verify admin status' });
    }
  };

  // Auth middleware
  await setupAuth(app);
  const server = createServer(app);

  // Chat rooms routes
  app.get('/api/rooms', isAuthenticated, async (req: Request, res: Response) => {
    try {
      const rooms = await storage.getChatRooms();
      res.json(rooms);
    } catch (error) {
      console.error('Error fetching rooms:', error);
      res.status(500).json({ error: 'Failed to fetch rooms' });
    }
  });

  app.post('/api/rooms', isAuthenticated, async (req: Request, res: Response) => {
    try {
      const user = req.user as AuthenticatedUser;
      const { name, description } = req.body;
      
      const roomData: InsertChatRoom = {
        name: name?.trim() || 'New Room',
        description: description?.trim() || null,
        createdBy: user.claims.sub,
      };

      const room = await storage.createChatRoom(roomData);
      res.json(room);
    } catch (error) {
      console.error('Error creating room:', error);
      res.status(500).json({ error: 'Failed to create room' });
    }
  });

  app.delete('/api/rooms/:id', isAuthenticated, async (req: Request, res: Response) => {
    try {
      const user = req.user as AuthenticatedUser;
      const roomId = parseInt(req.params.id);
      
      const success = await storage.deleteChatRoom(roomId, user.claims.sub);
      
      if (success) {
        res.json({ success: true });
      } else {
        res.status(403).json({ error: 'Unauthorized or room not found' });
      }
    } catch (error) {
      console.error('Error deleting room:', error);
      res.status(500).json({ error: 'Failed to delete room' });
    }
  });

  // Messages routes
  app.get('/api/rooms/:roomId/messages', isAuthenticated, async (req: Request, res: Response) => {
    try {
      const roomId = parseInt(req.params.roomId);
      const limit = parseInt(req.query.limit as string) || 200;
      
      const messages = await storage.getMessages(roomId, limit);
      console.log(`Fetched ${messages.length} messages for room ${roomId}`);
      res.json(messages);
    } catch (error) {
      console.error('Error fetching messages:', error);
      res.status(500).json({ error: 'Failed to fetch messages' });
    }
  });

  app.post('/api/rooms/:roomId/messages', isAuthenticated, async (req: Request, res: Response) => {
    try {
      const user = req.user as AuthenticatedUser;
      const roomId = parseInt(req.params.roomId);
      const { text, replyToId } = req.body;
      
      // Fetch sender's profile details to embed in message record
      const senderRecord = await storage.getUser(user.claims.sub);
      const senderProfileImageUrl = senderRecord?.useCustomProfileImage && senderRecord?.customProfileImageUrl
        ? senderRecord.customProfileImageUrl
        : senderRecord?.profileImageUrl ?? null;
      
      
      if (!text?.trim()) {
        return res.status(400).json({ error: 'Message text is required' });
      }

      const messageData: InsertMessage = {
        roomId,
        senderId: user.claims.sub,
        senderName: user.claims.first_name || user.claims.email || 'Anonymous',
        originalText: text.trim(),
        originalLanguage: detectLanguage(text.trim()),
        replyToId: replyToId || null,
        senderProfileImageUrl,
      };

      const message = await storage.createMessage(messageData);
      
      // Update room activity
      await storage.updateRoomActivity(roomId);
      
      res.json(message);
    } catch (error) {
      console.error('Error creating message:', error);
      res.status(500).json({ error: 'Failed to create message' });
    }
  });

  app.delete('/api/messages/:messageId', isAuthenticated, async (req: Request, res: Response) => {
    try {
      const user = req.user as AuthenticatedUser;
      const messageId = parseInt(req.params.messageId);
      
      const success = await storage.deleteMessage(messageId, user.claims.sub);
      
      if (success) {
        res.json({ success: true });
      } else {
        res.status(403).json({ error: 'Unauthorized or message not found' });
      }
    } catch (error) {
      console.error('Error deleting message:', error);
      res.status(500).json({ error: 'Failed to delete message' });
    }
  });

  // Admin user management endpoints
  app.get('/api/admin/users', requireAdmin, async (req: Request, res: Response) => {
    try {
      const usersList = await storage.getAllUsers();
      res.json(usersList);
    } catch (e) {
      res.status(500).json({ error: 'Failed to fetch users' });
    }
  });
  app.put('/api/admin/users/:id', requireAdmin, async (req: Request, res: Response) => {
    const { id } = req.params;
    const { isAdmin } = req.body;
    if (typeof isAdmin !== 'boolean') return res.status(400).json({ error: 'isAdmin must be boolean' });
    try {
      const updated = await storage.updateUserSettings(id, { isAdmin });
      res.json(updated);
    } catch (e) {
      res.status(500).json({ error: 'Failed to update user' });
    }
  });

// Admin Translation API CRUD routes
  app.get('/api/admin/translation-apis', requireAdmin, async (req: Request, res: Response) => {
    try {
      const apis = await storage.getTranslationApis();
      res.json(apis);
    } catch (err) {
      console.error('Failed to fetch translation APIs:', err);
      res.status(500).json({ error: 'Failed to fetch translation APIs' });
    }
  });

  app.post('/api/admin/translation-apis', requireAdmin, async (req: Request, res: Response) => {
    try {
      const { name, url, method = 'GET', priority = 1, isActive = true } = req.body;
      if (!name || !url) {
        return res.status(400).json({ error: 'Missing name or url' });
      }
      const api = await storage.createTranslationApi({ name, url, method, priority, isActive });
      res.json(api);
    } catch (err) {
      console.error('Failed to create translation API:', err);
      res.status(500).json({ error: 'Failed to create translation API' });
    }
  });

  app.put('/api/admin/translation-apis/:id', requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const updates = req.body;
      const api = await storage.updateTranslationApi(id, updates);
      res.json(api);
    } catch (err) {
      console.error('Failed to update translation API:', err);
      res.status(500).json({ error: 'Failed to update translation API' });
    }
  });

  app.delete('/api/admin/translation-apis/:id', requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const ok = await storage.deleteTranslationApi(id);
      res.json({ success: ok });
    } catch (err) {
      console.error('Failed to delete translation API:', err);
      res.status(500).json({ error: 'Failed to delete translation API' });
    }
  });

  // Translation route - blocked server-side to stop infinite loop
  app.post('/api/translate', async (req: Request, res: Response) => {
    try {
      const { text, source, target } = req.body;
      if (!text || !source || !target) {
        return res.status(400).json({ error: 'Missing parameters' });
      }
      const translated = await translateText(text, source, target);
      res.json({ translatedText: translated });
    } catch (error) {
      console.error('Translation API error:', error);
      res.status(500).json({ error: 'Translation failed' });
    }
  });

  // User settings routes
  app.get('/api/auth/user', isAuthenticated, async (req: Request, res: Response) => {
    try {
      const user = req.user as AuthenticatedUser;
      const userData = await storage.getUser(user.claims.sub);
      
      if (!userData) {
        return res.status(404).json({ error: 'User not found' });
      }
      
      res.json(userData);
    } catch (error) {
      console.error('Error fetching user:', error);
      res.status(500).json({ error: 'Failed to fetch user' });
    }
  });

  app.patch('/api/auth/user', isAuthenticated, async (req: Request, res: Response) => {
    try {
      const user = req.user as AuthenticatedUser;
      const updates = req.body;
      
      const updatedUser = await storage.updateUserSettings(user.claims.sub, updates);
      res.json(updatedUser);
    } catch (error) {
      console.error('Error updating user:', error);
      res.status(500).json({ error: 'Failed to update user' });
    }
  });

  // Update user settings
  app.patch('/api/user/settings', isAuthenticated, async (req: Request, res: Response) => {
    try {
      const user = req.user as AuthenticatedUser;
      const updates = req.body;
      const updatedUser = await storage.updateUserSettings(user.claims.sub, updates);
      res.json(updatedUser);
    } catch (error) {
      console.error('Error updating user settings:', error);
      res.status(500).json({ error: 'Failed to update settings' });
    }
  });

  // Update user profile image
  app.post('/api/user/profile-image', isAuthenticated, async (req: Request, res: Response) => {
    try {
      const user = req.user as AuthenticatedUser;
      const { imageUrl, useCustom } = req.body;
      
      console.log('Profile image update request:', {
        userId: user.claims.sub,
        imageUrlLength: imageUrl?.length || 0,
        useCustom,
        hasImageUrl: !!imageUrl
      });
      
      if (!imageUrl || typeof useCustom !== 'boolean') {
        console.log('Missing required fields for profile image update');
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const updatedUser = await storage.updateUserProfileImage(user.claims.sub, imageUrl, useCustom);
      console.log('Profile image updated successfully:', {
        userId: user.claims.sub,
        useCustomProfileImage: updatedUser.useCustomProfileImage,
        hasCustomImageUrl: !!updatedUser.customProfileImageUrl
      });
      res.json(updatedUser);
    } catch (error) {
      console.error('Error updating profile image:', error);
      res.status(500).json({ error: 'Failed to update profile image' });
    }
  });

  // Likes routes
  app.post('/api/messages/:messageId/like', isAuthenticated, async (req: Request, res: Response) => {
    try {
      const user = req.user as AuthenticatedUser;
      const messageId = parseInt(req.params.messageId);
      
      const result = await storage.toggleMessageLike(messageId, user.claims.sub);
      res.json(result);
    } catch (error) {
      console.error('Error toggling like:', error);
      res.status(500).json({ error: 'Failed to toggle like' });
    }
  });

  app.get('/api/messages/:messageId/likes', isAuthenticated, async (req: Request, res: Response) => {
    try {
      const messageId = parseInt(req.params.messageId);
      const likes = await storage.getMessageLikes(messageId);
      res.json(likes);
    } catch (error) {
      console.error('Error fetching likes:', error);
      res.status(500).json({ error: 'Failed to fetch likes' });
    }
  });

  app.get('/api/user/likes', isAuthenticated, async (req: Request, res: Response) => {
    try {
      const user = req.user as AuthenticatedUser;
      const likes = await storage.getUserLikes(user.claims.sub);
      res.json(likes);
    } catch (error) {
      console.error('Error fetching user likes:', error);
      res.status(500).json({ error: 'Failed to fetch user likes' });
    }
  });

  


  

  // Test admin endpoint
  app.get('/api/admin/test', isAuthenticated, async (req: Request, res: Response) => {
    try {
      const user = req.user as AuthenticatedUser;
      console.log('Admin test endpoint accessed by user:', user.claims.sub);
      const userData = await storage.getUser(user.claims.sub);
      console.log('User data in test endpoint:', userData);
      res.json({ 
        message: 'Admin test successful', 
        user: userData,
        isAdmin: userData?.isAdmin 
      });
    } catch (error) {
      console.error('Error in admin test:', error);
      res.status(500).json({ error: 'Test failed' });
    }
  });

  app.get('/api/admin/translation-apis', isAuthenticated, requireAdmin, async (req: Request, res: Response) => {
    try {
      const apis = await storage.getTranslationApis();
      res.json(apis);
    } catch (error) {
      console.error('Error fetching translation APIs:', error);
      res.status(500).json({ error: 'Failed to fetch translation APIs' });
    }
  });

  // Temporary direct API creation endpoint
  app.post('/api/translation-apis/create', isAuthenticated, async (req: Request, res: Response) => {
    try {
      const user = req.user as AuthenticatedUser;
      console.log('Direct API creation endpoint accessed by user:', user.claims.sub);
      const userData = await storage.getUser(user.claims.sub);
      console.log('User data for direct creation:', userData);
      
      if (!userData?.isAdmin) {
        return res.status(403).json({ error: 'Admin access required' });
      }
      
      console.log('Creating new translation API with data:', req.body);
      const { name, url, priority, isActive } = req.body;
      
      if (!name || !url) {
        return res.status(400).json({ error: 'Name and URL are required' });
      }
      
      const newApi = await storage.createTranslationApi({
        name,
        url,
        priority: priority || 1,
        isActive: isActive !== false
      });
      console.log('Successfully created translation API:', newApi);
      res.json(newApi);
    } catch (error) {
      console.error('Error creating translation API:', error);
      res.status(500).json({ error: 'Failed to create translation API', details: String(error) });
    }
  });

  app.post('/api/admin/translation-apis', isAuthenticated, requireAdmin, async (req: Request, res: Response) => {
    try {
      console.log('Creating new translation API with data:', req.body);
      const { name, url, priority, isActive } = req.body;
      
      if (!name || !url) {
        return res.status(400).json({ error: 'Name and URL are required' });
      }
      
      const newApi = await storage.createTranslationApi({
        name,
        url,
        priority: priority || 1,
        isActive: isActive !== false
      });
      console.log('Successfully created translation API:', newApi);
      res.json(newApi);
    } catch (error) {
      console.error('Error creating translation API:', error);
      res.status(500).json({ error: 'Failed to create translation API', details: String(error) });
    }
  });

  app.put('/api/admin/translation-apis/:id', isAuthenticated, requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const updates = req.body;
      const updatedApi = await storage.updateTranslationApi(id, updates);
      res.json(updatedApi);
    } catch (error) {
      console.error('Error updating translation API:', error);
      res.status(500).json({ error: 'Failed to update translation API' });
    }
  });

  app.delete('/api/admin/translation-apis/:id', isAuthenticated, requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const success = await storage.deleteTranslationApi(id);
      if (success) {
        res.json({ message: 'Translation API deleted successfully' });
      } else {
        res.status(404).json({ error: 'Translation API not found' });
      }
    } catch (error) {
      console.error('Error deleting translation API:', error);
      res.status(500).json({ error: 'Failed to delete translation API' });
    }
  });

  // WebSocket setup
  const wss = new WebSocketServer({ 
    server,
    path: '/websocket'
  });



  wss.on('connection', (ws: WebSocketClient, req) => {
    console.log('WebSocket client connected');
        ws.on('message', async (message: Buffer) => {
      let data: any;
      // 1. Parse incoming JSON safely
      try {
        data = JSON.parse(message.toString());
      } catch (parseError) {
        ws.send(
          JSON.stringify({
            type: 'error',
            message: 'Invalid JSON',
            timestamp: new Date().toISOString(),
          }),
        );
        return;
      }

      // 2. Handle message types
      try {
        switch (data.type) {
          case 'auth': {
            ws.userId = data.userId;
            ws.userName = data.userName;
            broadcastToAll(wss, {
              type: 'user_joined',
              userName: data.userName,
              timestamp: new Date().toISOString(),
            });
            break;
          }
          case 'join_room': {
            const prevRoom = ws.roomId;
            if (prevRoom !== undefined) {
              broadcastOnlineCount(wss, prevRoom);
            }
            ws.roomId = data.roomId;
            broadcastOnlineCount(wss, data.roomId);
            break;
          }
          case 'chat_message': {
            if (ws.roomId && ws.userId) {
              const messageData: InsertMessage = {
                roomId: ws.roomId,
                senderId: ws.userId,
                senderName: ws.userName || 'Unknown User',
                originalText: data.text,
                originalLanguage: detectLanguage(data.text),
                replyToId: data.replyToId || null,
                replyToText: data.replyToText || null,
                replyToSenderName: data.replyToSenderName || null,
                mentions: data.mentions || [],
              };
              try {
                const newMsg = await storage.createMessage(messageData);
                broadcastToRoom(wss, ws.roomId, {
                  type: 'new_message',
                  message: newMsg,
                  timestamp: new Date().toISOString(),
                });
              } catch (err) {
                ws.send(
                  JSON.stringify({
                    type: 'error',
                    message: 'Failed to save message',
                    timestamp: new Date().toISOString(),
                  }),
                );
              }
            }
            break;
          }
          case 'new_message': {
            if (ws.roomId) {
              broadcastToRoom(wss, ws.roomId, {
                type: 'new_message',
                message: data.message,
                timestamp: new Date().toISOString(),
              });
            }
            break;
          }
          case 'message_deleted': {
            if (ws.roomId) {
              broadcastToRoom(wss, ws.roomId, {
                type: 'message_deleted',
                messageId: data.messageId,
                timestamp: new Date().toISOString(),
              });
            }
            break;
          }
          case 'room_created': {
            broadcastToAll(wss, {
              type: 'room_created',
              room: data.room,
              timestamp: new Date().toISOString(),
            });
            break;
          }
          case 'room_deleted': {
            broadcastToAll(wss, {
              type: 'room_deleted',
              roomId: data.roomId,
              timestamp: new Date().toISOString(),
            });
            break;
          }
          case 'message_like_updated': {
            if (ws.roomId) {
              broadcastToRoom(wss, ws.roomId, {
                type: 'message_like_updated',
                messageId: data.messageId,
                liked: data.liked,
                totalLikes: data.totalLikes,
                userId: data.userId,
                timestamp: new Date().toISOString(),
              });
            }
            break;
          }
          default:
            // Unknown message type
            ws.send(
              JSON.stringify({
                type: 'error',
                message: 'Unknown message type',
                timestamp: new Date().toISOString(),
              }),
            );
        }
      } catch (handlerError) {
        console.error('WS handler error:', handlerError);
        ws.send(
          JSON.stringify({
            type: 'error',
            message: 'Server error',
            timestamp: new Date().toISOString(),
          }),
        );
      }
    });



    ws.on('close', () => {
      console.log('WebSocket client disconnected');
      if (ws.roomId !== undefined) {
        broadcastOnlineCount(wss, ws.roomId);
      }
      if (ws.userName) {
        broadcastToAll(wss, {
          type: 'user_left',
          userName: ws.userName,
          timestamp: new Date().toISOString()
        });
      }
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });
  });

  return server;
}