import { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useI18n } from '@/hooks/useI18n';
import { translationManager } from '@/lib/translationManager';
import { MessageBubble } from './MessageBubble';
import { MentionInput, type MentionInputRef } from './MentionInput';
import { getDisplayName } from '@/lib/profileUtils';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { getSupportedLanguages } from '@/lib/languageSupport';
import { Languages, Users, ArrowDown, Shield, Menu, MessageSquare } from 'lucide-react';
import type { Message, ChatRoom } from '@shared/schema';

// Room name translations
const roomNameTranslations: Record<string, Record<string, string>> = {
  'General Chat': {
    'ja': '一般チャット',
    'es': 'Chat General',
    'fr': 'Chat Général',
    'de': 'Allgemeiner Chat',
    'zh': '普通聊天',
    'ko': '일반 채팅',
    'pt': 'Chat Geral',
    'ru': 'Общий чат',
    'ar': 'دردشة عامة',
    'hi': 'सामान्य चैट',
    'it': 'Chat Generale',
    'nl': 'Algemene Chat',
    'th': 'แชททั่วไป',
    'vi': 'Trò chuyện chung'
  }
};

interface ChatContainerProps {
  roomId: number;
  onOpenSettings: () => void;
  onRoomSelect?: (roomId: number | undefined) => void;
}

export function ChatContainer({ roomId, onOpenSettings, onRoomSelect }: ChatContainerProps) {
  const { user } = useAuth();
  const { t } = useI18n();
  const { isConnected, isReconnecting, messages: allMessages, deletedMessageIds, messageLikes, onlineCount, sendMessage, joinRoom, setMessages: setAllMessages, toggleLike, initializeLikes } = useWebSocket();
  const queryClient = useQueryClient();
  
  // Load initial messages for the current room
  const { data: initialMessages, refetch: refetchMessages, isLoading: messagesLoading, error: messagesError } = useQuery({
    queryKey: ['/api/rooms', roomId, 'messages'],
    queryFn: async () => {
      const res = await fetch(`/api/rooms/${roomId}/messages`, { credentials: 'include' });
      if (!res.ok) throw new Error(`Failed to load messages: ${res.status}`);
      return res.json();
    },
    enabled: !!user && !!roomId,
    retry: false,
    staleTime: 0,
  });

  // Load current room information
  const { data: currentRoom } = useQuery({
    queryKey: ['/api/rooms', roomId],
    queryFn: () => fetch(`/api/rooms/${roomId}`, { credentials: 'include' }).then(res => res.json()),
    enabled: !!user && !!roomId,
  });

  // Load initial online count for the current room
  const { data: initialOnlineCount } = useQuery({
    queryKey: ['/api/rooms', roomId, 'online-count'],
    queryFn: () => fetch(`/api/rooms/${roomId}/online-count`, { credentials: 'include' }).then(res => res.json()),
    enabled: !!roomId,
    select: (data) => data.onlineCount,
  });

  // Load all rooms for mobile selector
  const { data: allRooms = [] } = useQuery({
    queryKey: ['/api/rooms'],
    enabled: !!user,
  });

  // Extract participant data directly from messages
  const getParticipantProfile = (senderId: string) => {
    // Find message from this sender to get their profile info
    const senderMessage = roomMessages.find(msg => msg.senderId === senderId);
    if (senderMessage) {
      const message = senderMessage as any;
      return {
        id: senderId,
        profileImageUrl: message.senderUseCustomProfileImage 
          ? message.senderCustomProfileImageUrl 
          : message.senderProfileImageUrl,
        firstName: message.senderFirstName,
        lastName: message.senderLastName,
        email: message.senderEmail,
      };
    }
    
    // Fallback to current user if it's their message
    if (user && senderId === (user as any).id) {
      return {
        id: (user as any).id,
        profileImageUrl: (user as any).useCustomProfileImage ? (user as any).customProfileImageUrl : (user as any).profileImageUrl,
        firstName: (user as any).firstName,
        lastName: (user as any).lastName,
        email: (user as any).email,
      };
    }
    
    return null;
  };

  // Load user's liked messages
  const { data: userLikes } = useQuery({
    queryKey: ['/api/user/likes'],
    queryFn: () => fetch('/api/user/likes', { credentials: 'include' }).then(res => res.json()),
    enabled: !!user,
  });

  // Initialize likes when user data is loaded
  useEffect(() => {
    if (userLikes?.likedMessageIds) {
      initializeLikes(userLikes.likedMessageIds);
    }
  }, [userLikes, initializeLikes]);



  const [roomMessages, setRoomMessages] = useState<Message[]>([]);
  const [translatedMessages, setTranslatedMessages] = useState<Map<number, string>>(new Map());
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<number | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [mentionedMessageIds, setMentionedMessageIds] = useState<Set<number>>(new Set());
  const [isUserScrolling, setIsUserScrolling] = useState(false);
  const [currentLanguage, setCurrentLanguage] = useState<string>(() => {
    const stored = localStorage.getItem('selectedLanguage') || 'ja';
    console.log(`🔍 INIT: Initial language state set to: ${stored}`);
    console.log(`🔍 INIT: localStorage content:`, localStorage.getItem('selectedLanguage'));
    return stored;
  });

  // Override setCurrentLanguage to track all changes
  const setCurrentLanguageWithDebug = (newLang: string) => {
    console.log(`🚨 LANGUAGE CHANGE DETECTED: ${currentLanguage} -> ${newLang}`);
    console.log(`🚨 STACK TRACE:`, new Error().stack);
    setCurrentLanguage(newLang);
  };

  // Get user's preferred language for room name translation
  // Use the local state which is always up-to-date
  const userLanguage = currentLanguage;

  // Function to translate room names
  const translateRoomName = (roomName: string): string => {
    if (roomNameTranslations[roomName] && roomNameTranslations[roomName][userLanguage]) {
      return roomNameTranslations[roomName][userLanguage];
    }
    return roomName;
  };

  // Function to get user profile image directly from message data
  const getUserProfileImage = (userId: string): string | undefined => {
    const profile = getParticipantProfile(userId);
    return profile?.profileImageUrl;
  };
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const mentionInputRef = useRef<MentionInputRef>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const userScrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Debug: Track all language state changes
  useEffect(() => {
    console.log(`🎯 LANGUAGE STATE CHANGED: currentLanguage = ${currentLanguage}`);
    console.log(`🎯 TRANSLATION MANAGER LANGUAGE: ${translationManager.currentUserLanguage}`);
    
    // Ensure TranslationManager is synced with current language
    translationManager.setUserLanguage(currentLanguage);
  }, [currentLanguage]);

  // Initialize and sync local language state with user data (run only once when user data loads)
  useEffect(() => {
    if (user && (user as any)?.preferredLanguage) {
      const serverLanguage = (user as any).preferredLanguage;
      console.log(`📊 INIT: User database language: ${serverLanguage}, current state: ${currentLanguage}`);
      
      // Always sync with server data, but preserve localStorage overrides
      const savedLanguage = localStorage.getItem('selectedLanguage');
      if (!savedLanguage) {
        console.log(`🔄 INIT: Setting language from server: ${serverLanguage}`);
        setCurrentLanguageWithDebug(serverLanguage);
        localStorage.setItem('selectedLanguage', serverLanguage);
      } else {
        console.log(`💾 INIT: Using saved language: ${savedLanguage}`);
        // Ensure current state matches localStorage
        if (currentLanguage !== savedLanguage) {
          console.log(`🔄 INIT: Syncing current state to localStorage: ${savedLanguage}`);
          setCurrentLanguageWithDebug(savedLanguage);
        }
      }
    }
  }, [user]);

  // Initialize audio for notifications and request notification permission
  useEffect(() => {
    audioRef.current = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmAaAzqJ0/LNgC4NLIzU8t2QQAoUXrTp66hVFApGn+DyvmAaAzqJ0/LNgC4N');
    
    // Request notification permission (check if Notification API is available)
    if (typeof window !== 'undefined' && 'Notification' in window) {
      if (Notification.permission === 'default') {
        Notification.requestPermission().then(permission => {
          console.log('Notification permission:', permission);
        });
      }
    }
  }, []);

  // Function to check if current user is mentioned in a message
  const isUserMentioned = (message: Message): boolean => {
    if (!user || !message.originalText) return false;
    const currentUserName = getDisplayName(user);
    const mentionPattern = new RegExp(`@${currentUserName}\\b`, 'i');
    const isMentioned = mentionPattern.test(message.originalText);
    
    console.log('Checking mention:', {
      messageText: message.originalText,
      currentUserName,
      pattern: `@${currentUserName}\\b`,
      isMentioned
    });
    
    return isMentioned;
  };

  // Function to play notification sound
  const playNotificationSound = () => {
    if (audioRef.current) {
      audioRef.current.currentTime = 0;
      audioRef.current.play().catch(err => {
        console.log('Could not play notification sound:', err);
      });
    }
  };



  // Reload messages when room changes (without clearing)
  useEffect(() => {
    if (roomId) {
      refetchMessages();
    }
    
    // Join the new room via WebSocket
    if (isConnected && roomId) {
      joinRoom(roomId);
    }
  }, [roomId, refetchMessages, isConnected, joinRoom]);

  // Join room when WebSocket connects
  useEffect(() => {
    if (isConnected && roomId) {
      console.log('Joining room via useEffect:', roomId);
      joinRoom(roomId);
    }
  }, [isConnected, roomId, joinRoom]);



  // Merge initial messages from database with real-time WebSocket messages
  useEffect(() => {
    const dbMessages = initialMessages && Array.isArray(initialMessages) ? initialMessages : [];
    const wsMessages = allMessages.filter(msg => msg.roomId === roomId);
    
    // Create a map to deduplicate messages by ID
    const messageMap = new Map<number, Message>();
    
    // Add database messages first, but skip deleted ones
    dbMessages.forEach(msg => {
      if (msg.id && !deletedMessageIds.has(msg.id)) {
        messageMap.set(msg.id, msg);
      }
    });
    
    // Add/update with WebSocket messages (newer data), but skip deleted ones
    wsMessages.forEach(msg => {
      if (msg.id && !deletedMessageIds.has(msg.id)) {
        messageMap.set(msg.id, msg);
      }
    });
    
    // Convert back to array and sort by timestamp
    const mergedMessages = Array.from(messageMap.values())
      .sort((a, b) => new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime());
    
    console.log('Merged messages for room', roomId, ':', mergedMessages.length, 'total messages');
    
    // Check for new mentions and trigger notifications
    const previousMessageIds = new Set(roomMessages.map(msg => msg.id));
    const newMentions = new Set<number>();
    
    console.log('Checking for mentions in merged messages:', {
      currentUserId: (user as any)?.id,
      previousMessageCount: previousMessageIds.size,
      newMessageCount: mergedMessages.length
    });
    
    mergedMessages.forEach(message => {
      const isNewMessage = message.id && !previousMessageIds.has(message.id);
      const isNotFromSelf = message.senderId !== (user as any)?.id;
      const isMentioned = isUserMentioned(message);
      
      console.log('Message check:', {
        messageId: message.id,
        senderId: message.senderId,
        currentUserId: (user as any)?.id,
        isNewMessage,
        isNotFromSelf,
        isMentioned,
        messageText: message.originalText
      });
      
      // Only check new messages (not from initial load) and not from current user
      if (isNewMessage && isNotFromSelf && isMentioned) {
        console.log('🔔 MENTION DETECTED! Playing notification sound and showing alert');
        newMentions.add(message.id);
        
        // Play notification sound for new mentions
        playNotificationSound();
        
        // Show browser notification if permission granted
        if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
          new Notification(`メンション通知 - ${message.senderName}`, {
            body: message.originalText,
            icon: message.senderProfileImageUrl || '/favicon.ico',
            tag: `mention-${message.id}`
          });
        } else {
          console.log('Notification permission not granted or not available:', 
            typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'API not available');
        }
      }
    });
    
    // Update mentioned message IDs
    setMentionedMessageIds(prev => {
      const updated = new Set(prev);
      mergedMessages.forEach(message => {
        if (message.id && isUserMentioned(message)) {
          updated.add(message.id);
        }
      });
      return updated;
    });
    
    setRoomMessages(mergedMessages);
  }, [initialMessages, allMessages, roomId, deletedMessageIds, user, playNotificationSound, isUserMentioned]);

  // Auto-scroll to bottom when new messages arrive
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    setShowScrollToBottom(false);
  };

  // Check if user is near bottom of scroll area
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const element = e.target as HTMLDivElement;
    const isNearBottom = element.scrollTop + element.clientHeight >= element.scrollHeight - 100;
    setShowScrollToBottom(!isNearBottom && roomMessages.length > 0);
    
    // Track user scrolling behavior
    setIsUserScrolling(true);
    
    // Clear any existing timeout and set a new one
    if (userScrollTimeoutRef.current) {
      clearTimeout(userScrollTimeoutRef.current);
    }
    
    // Reset user scrolling state after they stop scrolling for 2 seconds
    userScrollTimeoutRef.current = setTimeout(() => {
      setIsUserScrolling(false);
    }, 2000);
  };

  // Auto-scroll to bottom when new messages arrive (only if user is not manually scrolling)
  useEffect(() => {
    // Only auto-scroll if:
    // 1. User is not currently scrolling manually
    // 2. User is already at the bottom (showScrollToBottom is false)
    // 3. We have messages to show
    if (!isUserScrolling && !showScrollToBottom && roomMessages.length > 0) {
      const timeoutId = setTimeout(() => scrollToBottom(), 100);
      return () => clearTimeout(timeoutId);
    }
  }, [roomMessages.length, isUserScrolling, showScrollToBottom]);

  // Translation manager completely disabled to prevent infinite loop
  useEffect(() => {
    console.log(`Language changed to: ${currentLanguage} (translation disabled)`);
    // Translation functionality completely disabled
    setTranslatedMessages(new Map());
  }, [currentLanguage]);

  // DISABLED: Translation system completely removed to prevent infinite loop

  // Manual translation handler for translate buttons
  const handleManualTranslation = useCallback((messageId: number, text: string, sourceLanguage: string, targetLanguage: string) => {
    const message = roomMessages.find(m => m.id === messageId);
    if (!message) return;

    console.log(`Manual translation requested: "${text}" (${sourceLanguage} -> ${targetLanguage})`);
    
    translationManager.translateMessage(
      message,
      targetLanguage,
      'high',
      (translatedResult) => {
        setTranslatedMessages(prev => {
          const updated = new Map(prev);
          updated.set(messageId, translatedResult);
          return updated;
        });
      }
    );
  }, [roomMessages]);

  const handleSendMessage = (text: string, mentions?: string[]) => {
    if (!text.trim()) return;
    
    // Send message with the current room ID and reply information
    sendMessage(text.trim(), roomId, replyingTo, mentions);
    
    // Clear reply state after sending
    setReplyingTo(null);
    
    // Force scroll to bottom after sending own message
    setTimeout(() => {
      scrollToBottom();
    }, 100);
  };

  const handleReply = (message: Message) => {
    setReplyingTo(message);
    // Focus the message input after setting reply
    setTimeout(() => {
      mentionInputRef.current?.focus();
    }, 100);
  };

  const handleDeleteMessage = async (messageId: number) => {
    try {
      const response = await fetch(`/api/messages/${messageId}`, {
        method: 'DELETE',
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error('Failed to delete message');
      }

      // Message will be removed via WebSocket broadcast
    } catch (error) {
      console.error('Error deleting message:', error);
      alert('メッセージの削除に失敗しました');
    }
  };

  const handleCancelReply = () => {
    setReplyingTo(null);
  };

  const handleNavigateToMessage = (messageId: number) => {
    const messageElement = document.getElementById(`message-${messageId}`);
    if (messageElement) {
      messageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
      
      // Highlight the message temporarily
      setHighlightedMessageId(messageId);
      setTimeout(() => {
        setHighlightedMessageId(null);
      }, 3000); // Remove highlight after 3 seconds
    }
  };

  // Language change mutation
  const updateLanguageMutation = useMutation({
    mutationFn: async (newLanguage: string) => {
      const response = await apiRequest('PATCH', '/api/user/settings', { 
        preferredLanguage: newLanguage 
      });
      return await response.json();
    },
    onSuccess: (updatedUser) => {
      const newLang = (updatedUser as any)?.preferredLanguage;
      console.log('Language updated successfully to:', newLang);
      
      // Update query cache
      queryClient.setQueryData(['/api/auth/user'], updatedUser);
      
      // Update localStorage
      const wsUserData = localStorage.getItem('wsUserData');
      if (wsUserData) {
        try {
          const parsedData = JSON.parse(wsUserData);
          const updatedUserData = { ...parsedData, ...updatedUser };
          localStorage.setItem('wsUserData', JSON.stringify(updatedUserData));
        } catch (error) {
          console.error('Error updating localStorage user data:', error);
        }
      }
      
      // Force component re-render by invalidating user query
      queryClient.invalidateQueries({ queryKey: ['/api/auth/user'] });
    },
    onError: (error) => {
      console.error('Language update failed:', error);
    },
  });

  const handleLanguageChange = (newLanguage: string) => {
    console.log(`🔄 User selected language: ${newLanguage}, current language: ${currentLanguage}`);
    
    if (newLanguage === currentLanguage) {
      console.log('Same language selected, skipping update');
      return;
    }
    
    console.log(`🌐 Immediately updating language to: ${newLanguage}`);
    
    // Update local state immediately for responsive UI
    setCurrentLanguageWithDebug(newLanguage);
    localStorage.setItem('selectedLanguage', newLanguage);
    
    // FORCE COMPLETE RESET - Clear everything translation-related
    setTranslatedMessages(new Map());
    translationManager.setUserLanguage(newLanguage);
    
    // Force immediate page refresh-like behavior for translations
    setTimeout(() => {
      // Clear all cached translations completely
      setTranslatedMessages(new Map());
      
      // Force re-translation of all messages with new language
      if (roomMessages.length > 0) {
        console.log(`🔄 FORCING COMPLETE RE-TRANSLATION to ${newLanguage} for ${roomMessages.length} messages`);
        
        const freshTranslations = new Map<number, string>();
        let processedCount = 0;

        roomMessages.forEach((msg) => {
          translationManager.translateMessage(msg, newLanguage, 'normal', (translated) => {
            freshTranslations.set(msg.id, translated);
            processedCount += 1;
            if (processedCount === roomMessages.length) {
              setTranslatedMessages(freshTranslations);
            }
          });
        });
      }
    }, 200); // Small delay to ensure state is completely reset
    
    // Update server settings
    updateLanguageMutation.mutate(newLanguage);
  };

  return (
    <main className="flex-1 flex flex-col w-full h-full">


      {/* Chat Header */}
      <div className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-3 sm:px-4 py-3 flex-shrink-0">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          {/* Room Info */}
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-lg font-medium text-gray-900 dark:text-white truncate">
              {currentRoom?.name ? translateRoomName(currentRoom.name) : 'チャットルーム'}
            </h2>
            {currentRoom?.description && (
              <span className="text-sm text-gray-500 dark:text-gray-400 hidden sm:inline">
                {currentRoom.description}
              </span>
            )}
            {currentRoom?.adminOnly && (
              <Badge variant="destructive" className="flex items-center gap-1 text-xs">
                <Shield className="w-3 h-3" />
                <span className="hidden xs:inline">Admin Only</span>
              </Badge>
            )}
            <Badge variant="secondary" className="flex items-center gap-1 text-xs">
              <Users className="w-3 h-3" />
              <span className="min-w-[1ch]">{onlineCount !== null ? onlineCount : (initialOnlineCount ?? 0)}</span>
            </Badge>
          </div>
          
          {/* Controls */}
          <div className="flex items-center gap-2 flex-wrap">
            {/* Mobile: Back to rooms button */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => onRoomSelect?.(undefined)}
              className="lg:hidden h-8 px-3 text-sm font-medium"
            >
              <MessageSquare className="w-4 h-4 mr-2" />
              ルーム一覧
            </Button>
            
            {/* Language Selector - Debug Version */}
            <div className="flex items-center gap-2">
              <Languages className="w-4 h-4 text-gray-500 dark:text-gray-400" />
              <select
                value={currentLanguage}
                onChange={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const newLang = e.target.value;
                  console.log(`🎯 SELECT CHANGE: ${currentLanguage} -> ${newLang}`);
                  
                  // Immediate state update
                  setCurrentLanguageWithDebug(newLang);
                  localStorage.setItem('selectedLanguage', newLang);
                  
                  // Clear and retranslate
                  setTranslatedMessages(new Map());
                  translationManager.setUserLanguage(newLang);
                  
                  console.log(`✅ Language changed to: ${newLang}`);
                }}
                onFocus={() => console.log(`🔍 SELECT FOCUSED: current = ${currentLanguage}`)}
                onBlur={() => console.log(`🔍 SELECT BLURRED: current = ${currentLanguage}`)}
                className="w-[120px] sm:w-[200px] h-8 text-xs border border-gray-300 dark:border-gray-600 rounded px-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 font-medium cursor-pointer"
              >
                {getSupportedLanguages().map((lang) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.nativeName}
                  </option>
                ))}
              </select>
              <span className="text-xs text-gray-500 ml-1">
                Current: {currentLanguage}
              </span>
            </div>
            

          </div>
        </div>
      </div>



      {/* Messages Container */}
      <div className="flex-1 overflow-hidden relative">
        <ScrollArea 
          className="h-full px-2 sm:px-4 py-2 sm:py-4" 
          ref={scrollAreaRef}
          onScrollCapture={handleScroll}
        >
          <div className="space-y-2 sm:space-y-4 pb-4">
            {roomMessages
              .filter((message: Message, index: number, self: Message[]) => 
                index === self.findIndex((m: Message) => m.id === message.id)
              )
              .sort((a: Message, b: Message) => {
                // First sort by original timestamp to maintain chronological order
                const timeComparison = new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime();
                
                // If timestamps are very close (within same second), prioritize translated messages
                const aTime = new Date(a.timestamp || 0).getTime();
                const bTime = new Date(b.timestamp || 0).getTime();
                const timeDiff = Math.abs(aTime - bTime);
                if (timeDiff < 1000) {
                  const aHasTranslation = translatedMessages.has(a.id);
                  const bHasTranslation = translatedMessages.has(b.id);
                  
                  if (aHasTranslation && !bHasTranslation) return 1; // Move translated messages later (appear after)
                  if (!aHasTranslation && bHasTranslation) return -1; // Move non-translated messages earlier
                }
                
                return timeComparison;
              })
              .map((message: Message) => {
                const translation = translatedMessages.get(message.id);
                
                // Use multiple fallbacks to determine if message is from current user
                const currentUserId = (user as any)?.id || localStorage.getItem('currentUserId') || "19464369";
                const isOwnMessage = message.senderId === currentUserId;
                
                // Store current user ID in localStorage for consistency
                if ((user as any)?.id && localStorage.getItem('currentUserId') !== (user as any).id) {
                  localStorage.setItem('currentUserId', (user as any).id);
                }
                

                
                const likeData = messageLikes.get(message.id);
                
                return (
                  <MessageBubble
                    key={`msg-${message.id}`}
                    message={message}
                    translatedText={translation}
                    isOwnMessage={isOwnMessage}
                    showOriginal={(user as any)?.showOriginalText || false}
                    currentUserLanguage={(user as any)?.preferredLanguage || 'en'}
                    onReply={handleReply}
                    onNavigateToMessage={handleNavigateToMessage}
                    onDelete={message.senderId === currentUserId || (user as any)?.email === 'yaaizzy39@gmail.com' ? handleDeleteMessage : undefined}
                    isHighlighted={highlightedMessageId === message.id}
                    isMentioned={mentionedMessageIds.has(message.id)}
                    totalLikes={likeData?.totalLikes || 0}
                    userLiked={likeData?.userLiked || false}
                    onToggleLike={() => toggleLike(message.id)}
                    userProfileImage={getUserProfileImage(message.senderId)}
                    onTranslate={handleManualTranslation}
                  />
                );
              })}
            
            {!isConnected && (
              <div className="flex justify-center py-2">
                <Badge variant={isReconnecting ? "secondary" : "destructive"} className={isReconnecting ? "animate-pulse" : ""}>
                  {isReconnecting ? "再接続中..." : t('chat.disconnected')}
                </Badge>
              </div>
            )}
            
            {/* Invisible element to scroll to */}
            <div ref={messagesEndRef} />
          </div>
        </ScrollArea>

        {/* Jump to Latest Button */}
        {showScrollToBottom && (
          <div className="absolute bottom-4 right-4 z-10">
            <Button
              onClick={scrollToBottom}
              size="sm"
              className="shadow-lg bg-primary hover:bg-primary/90 text-primary-foreground rounded-full p-3"
            >
              <ArrowDown className="w-4 h-4" />
            </Button>
          </div>
        )}
      </div>

      {/* Message Input - Fixed at bottom */}
      <div className="flex-shrink-0">
        {currentRoom?.adminOnly && !(user as any)?.isAdmin ? (
          <div className="bg-gray-50 dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 px-4 py-3">
            <div className="flex items-center justify-center gap-2 text-sm text-gray-500 dark:text-gray-400">
              <Shield className="w-4 h-4" />
              <span>This room is restricted to administrators only</span>
            </div>
          </div>
        ) : (
          <MentionInput 
            ref={mentionInputRef}
            onSendMessage={handleSendMessage} 
            replyingTo={replyingTo}
            onCancelReply={handleCancelReply}
            roomId={roomId}
          />
        )}
      </div>
    </main>
  );
}
