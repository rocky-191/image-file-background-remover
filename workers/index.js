/**
 * Image Background Remover - Cloudflare Worker
 * 
 * 功能：
 * - 图片去背景 API
 * - Google OAuth 登录
 * - 用户会话管理（JWT 方式，无需 KV）
 */

const REMOVE_BG_API_URL = 'https://api.remove.bg/v1.0/removebg'

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo'

const SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'openid'
].join(' ')

const JWT_SECRET = 'your-secret-key-change-in-production'

function base64UrlEncode(data) {
  return btoa(JSON.stringify(data))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/')
  while (str.length % 4) str += '='
  return JSON.parse(atob(str))
}

function createJWT(payload) {
  const header = { alg: 'HS256', typ: 'JWT' }
  const signature = base64UrlEncode({ ...payload, secret: JWT_SECRET })
  return base64UrlEncode(header) + '.' + base64UrlEncode(payload) + '.' + signature
}

function verifyJWT(token) {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const payload = base64UrlDecode(parts[1])
    if (payload.exp && payload.exp < Date.now()) return null
    return payload
  } catch {
    return null
  }
}

function handleCors(request) {
  const origin = request.headers.get('Origin') || '*'
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Cookie',
      'Access-Control-Allow-Credentials': 'true',
    },
  })
}

function jsonResponse(data, status, request) {
  status = status || 200
  const origin = request.headers.get('Origin') || '*'
  return new Response(JSON.stringify(data), {
    status: status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
    },
  })
}

function validateImage(buffer) {
  if (buffer.length > 10 * 1024 * 1024) {
    return { valid: false, error: '图片大小不能超过 10MB' }
  }
  const header = buffer.slice(0, 4)
  const isJpeg = header[0] === 0xFF && header[1] === 0xD8
  const isPng = header[0] === 0x89 && header[1] === 0x50
  const isWebp = header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46
  if (!isJpeg && !isPng && !isWebp) {
    return { valid: false, error: '不支持的图片格式' }
  }
  return { valid: true }
}

async function removeBackground(imageBuffer, apiKey) {
  const formData = new FormData()
  formData.append('image_file', new Blob([imageBuffer]), 'image.png')
  formData.append('size', 'auto')

  const response = await fetch(REMOVE_BG_API_URL, {
    method: 'POST',
    headers: { 'X-Api-Key': apiKey },
    body: formData,
  })

  if (!response.ok) {
    const errorText = await response.text()
    console.error('Remove.bg API error:', errorText)
    throw new Error('API error: ' + response.status)
  }

  return response.arrayBuffer()
}

function getToken(request) {
  const cookieHeader = request.headers.get('Cookie') || ''
  const cookies = Object.fromEntries(
    cookieHeader.split('; ').map(function(c) { return c.split('='); })
  )
  return cookies.token || null
}

function getCurrentUser(request) {
  const token = getToken(request)
  if (!token) return null
  return verifyJWT(token)
}

async function handleImageUpload(request, env) {
  const user = getCurrentUser(request)
  
  const apiKey = env.REMOVE_BG_API_KEY
  if (!apiKey) {
    return jsonResponse({ error: 'API Key 未配置' }, 500, request)
  }

  const arrayBuffer = await request.arrayBuffer()
  const uint8Array = new Uint8Array(arrayBuffer)
  
  const validation = validateImage(uint8Array)
  if (!validation.valid) {
    return jsonResponse({ error: validation.error }, 400, request)
  }

  try {
    const resultBuffer = await removeBackground(uint8Array, apiKey)
    return new Response(resultBuffer, {
      headers: {
        'Content-Type': 'image/png',
        'Access-Control-Allow-Origin': request.headers.get('Origin') || '*',
        'Content-Disposition': 'attachment; filename="result.png"',
      },
    })
  } catch (error) {
    console.error('处理失败:', error)
    return jsonResponse({ error: '处理失败: ' + error.message }, 500, request)
  }
}

function handleLogin(request, env) {
  const state = crypto.randomUUID()
  const origin = new URL(request.url).origin

  const authUrl = new URL(GOOGLE_AUTH_URL)
  authUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID)
  authUrl.searchParams.set('redirect_uri', origin + '/callback')
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', SCOPES)
  authUrl.searchParams.set('state', state)

  return new Response(null, {
    status: 302,
    headers: {
      'Location': authUrl.toString(),
      'Set-Cookie': 'oauth_state=' + state + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=600',
    },
  })
}

async function handleCallback(request, env) {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const origin = new URL(request.url).origin

  const cookieHeader = request.headers.get('Cookie') || ''
  const cookies = Object.fromEntries(
    cookieHeader.split('; ').map(function(c) { return c.split('='); })
  )
  const savedState = cookies.oauth_state

  if (!code || state !== savedState) {
    return new Response('Invalid state or missing code', { status: 400 })
  }

  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: origin + '/callback',
      grant_type: 'authorization_code',
    }),
  })

  const tokens = await tokenResponse.json()

  if (tokens.error) {
    return new Response('Error: ' + (tokens.error_description || tokens.error), { status: 400 })
  }

  const userResponse = await fetch(GOOGLE_USERINFO_URL, {
    headers: { 'Authorization': 'Bearer ' + tokens.access_token },
  })
  const userInfo = await userResponse.json()

  const payload = {
    id: userInfo.id,
    email: userInfo.email,
    name: userInfo.name,
    picture: userInfo.picture,
    iat: Date.now(),
    exp: Date.now() + 30 * 24 * 60 * 60 * 1000
  }
  const token = createJWT(payload)

  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/',
      'Set-Cookie': 'token=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + (30 * 24 * 60 * 60),
    },
  })
}

function handleLogout(request) {
  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/',
      'Set-Cookie': 'token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    },
  })
}

function handleGetUser(request, env) {
  const user = getCurrentUser(request)
  
  if (!user) {
    return jsonResponse({ loggedIn: false }, 200, request)
  }

  return jsonResponse({
    loggedIn: true,
    user: {
      email: user.email,
      name: user.name,
      picture: user.picture,
    },
  }, 200, request)
}

async function handleRequest(request, env) {
  if (request.method === 'OPTIONS') {
    return handleCors(request)
  }

  const url = new URL(request.url)
  
  if (url.pathname === '/api/remove-bg' && request.method === 'POST') {
    return handleImageUpload(request, env)
  }

  if (url.pathname === '/api/user' && request.method === 'GET') {
    return handleGetUser(request, env)
  }

  if (url.pathname === '/login') {
    return handleLogin(request, env)
  }

  if (url.pathname === '/callback') {
    return handleCallback(request, env)
  }

  if (url.pathname === '/logout') {
    return handleLogout(request)
  }

  if (url.pathname === '/health') {
    return jsonResponse({ 
      status: 'ok',
      apiKeyConfigured: !!env.REMOVE_BG_API_KEY,
      oauthConfigured: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)
    }, 200, request)
  }

  return new Response('Not Found', { status: 404 })
}

addEventListener('fetch', function(event) {
  event.respondWith(handleRequest(event.request, event.env))
})
