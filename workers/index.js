/**
 * Image Background Remover - Cloudflare Worker
 * 
 * 功能：
 * - 图片去背景 API
 * - Google OAuth 登录
 * - PayPal 支付集成
 * - 用户会话管理（JWT 方式）
 */

const REMOVE_BG_API_URL = 'https://api.remove.bg/v1.0/removebg'

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo'

const PAYPAL_API_URL = 'https://api-m.paypal.com'

const SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'openid'
].join(' ')

const JWT_SECRET = 'your-secret-key-change-in-production'

// 套餐配置（需与前端一致）
const PACKAGES = {
  credits_3: { credits: 3, price: 0.99 },
  credits_10: { credits: 10, price: 2.99 },
  credits_50: { credits: 50, price: 12.99 },
}

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

// 获取用户次数（从 D1 或内存）
async function getUserCredits(userId, env) {
  if (!env.DB) {
    // 无数据库时返回内存中的数据（仅用于测试）
    return env.USER_CREDITS ? JSON.parse(env.USER_CREDITS) : {}
  }
  
  try {
    const stmt = await env.DB.prepare(
      'SELECT credits FROM user_credits WHERE user_id = ?'
    ).bind(userId).first()
    return stmt?.credits || 0
  } catch (err) {
    console.error('获取用户次数失败:', err)
    return 0
  }
}

// 更新用户次数
async function updateUserCredits(userId, credits, env) {
  if (!env.DB) {
    // 无数据库时返回成功
    return true
  }
  
  try {
    const existing = await env.DB.prepare(
      'SELECT id FROM user_credits WHERE user_id = ?'
    ).bind(userId).first()
    
    if (existing) {
      await env.DB.prepare(
        'UPDATE user_credits SET credits = ?, updated_at = ? WHERE user_id = ?'
      ).bind(credits, Date.now(), userId).run()
    } else {
      await env.DB.prepare(
        'INSERT INTO user_credits (user_id, credits, created_at, updated_at) VALUES (?, ?, ?, ?)'
      ).bind(userId, credits, Date.now(), Date.now()).run()
    }
    return true
  } catch (err) {
    console.error('更新用户次数失败:', err)
    return false
  }
}

// 添加购买记录
async function addPurchaseRecord(userId, packageId, credits, amount, paypalOrderId, env) {
  if (!env.DB) {
    return true
  }
  
  try {
    await env.DB.prepare(
      'INSERT INTO purchases (user_id, package_id, credits, amount, paypal_order_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(userId, packageId, credits, amount, paypalOrderId, 'completed', Date.now()).run()
    return true
  } catch (err) {
    console.error('添加购买记录失败:', err)
    return false
  }
}

// PayPal API 调用
async function paypalApi(endpoint, method, body, env) {
  const clientId = env.PAYPAL_CLIENT_ID
  const clientSecret = env.PAYPAL_CLIENT_SECRET
  
  // 获取 access token
  const authResponse = await fetch(`${PAYPAL_API_URL}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + btoa(clientId + ':' + clientSecret),
    },
    body: 'grant_type=client_credentials',
  })
  
  if (!authResponse.ok) {
    throw new Error('PayPal认证失败')
  }
  
  const authData = await authResponse.json()
  const accessToken = authData.access_token
  
  // 调用 PayPal API
  const response = await fetch(`${PAYPAL_API_URL}${endpoint}`, {
    method: method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + accessToken,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  
  return response
}

async function handleImageUpload(request, env) {
  const user = getCurrentUser(request)
  
  if (!user) {
    return jsonResponse({ error: '请先登录' }, 401, request)
  }
  
  const apiKey = env.REMOVE_BG_API_KEY
  if (!apiKey) {
    return jsonResponse({ error: 'API Key 未配置' }, 500, request)
  }

  // 检查用户次数
  const currentCredits = await getUserCredits(user.id, env)
  if (currentCredits <= 0) {
    return jsonResponse({ error: '次数用完', code: 'CREDITS_EXHAUSTED' }, 403, request)
  }

  const arrayBuffer = await request.arrayBuffer()
  const uint8Array = new Uint8Array(arrayBuffer)
  
  const validation = validateImage(uint8Array)
  if (!validation.valid) {
    return jsonResponse({ error: validation.error }, 400, request)
  }

  try {
    const resultBuffer = await removeBackground(uint8Array, apiKey)
    
    // 扣除次数
    await updateUserCredits(user.id, currentCredits - 1, env)
    
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

async function handleGetUser(request, env) {
  const user = getCurrentUser(request)
  
  if (!user) {
    return jsonResponse({ loggedIn: false }, 200, request)
  }

  const credits = await getUserCredits(user.id, env)
  
  return jsonResponse({
    loggedIn: true,
    user: {
      email: user.email,
      name: user.name,
      picture: user.picture,
    },
    usage: {
      remaining: credits,
    },
  }, 200, request)
}

// PayPal 配置
async function handlePaypalConfig(request, env) {
  const clientId = env.PAYPAL_CLIENT_ID || ''
  return jsonResponse({
    clientId: clientId,
    configured: !!clientId,
  }, 200, request)
}

// 创建 PayPal 订单
async function handlePaypalCreateOrder(request, env) {
  const user = getCurrentUser(request)
  
  if (!user) {
    return jsonResponse({ error: '请先登录' }, 401, request)
  }
  
  const clientId = env.PAYPAL_CLIENT_ID
  const clientSecret = env.PAYPAL_CLIENT_SECRET
  
  if (!clientId || !clientSecret) {
    return jsonResponse({ error: 'PayPal 未配置' }, 500, request)
  }
  
  try {
    const body = await request.json()
    const packageId = body.packageId
    const pkg = PACKAGES[packageId]
    
    if (!pkg) {
      return jsonResponse({ error: '无效的套餐' }, 400, request)
    }
    
    // 获取 access token
    const authResponse = await fetch(`${PAYPAL_API_URL}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + btoa(clientId + ':' + clientSecret),
      },
      body: 'grant_type=client_credentials',
    })
    
    const authData = await authResponse.json()
    const accessToken = authData.access_token
    
    // 创建订单
    const orderResponse = await fetch(`${PAYPAL_API_URL}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + accessToken,
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          description: `Image Background Remover - ${pkg.credits} Credits`,
          amount: {
            currency_code: 'USD',
            value: pkg.price.toFixed(2),
          },
        }],
      }),
    })
    
    const orderData = await orderResponse.json()
    
    if (!orderResponse.ok) {
      throw new Error(orderData.message || '创建订单失败')
    }
    
    return jsonResponse({
      orderID: orderData.id,
      packageId: packageId,
      credits: pkg.credits,
    }, 200, request)
    
  } catch (err) {
    console.error('创建 PayPal 订单失败:', err)
    return jsonResponse({ error: err.message }, 500, request)
  }
}

// 确认 PayPal 订单
async function handlePaypalCapture(request, env) {
  const user = getCurrentUser(request)
  
  if (!user) {
    return jsonResponse({ error: '请先登录' }, 401, request)
  }
  
  const clientId = env.PAYPAL_CLIENT_ID
  const clientSecret = env.PAYPAL_CLIENT_SECRET
  
  if (!clientId || !clientSecret) {
    return jsonResponse({ error: 'PayPal 未配置' }, 500, request)
  }
  
  try {
    const body = await request.json()
    const { orderID, packageId } = body
    const pkg = PACKAGES[packageId]
    
    if (!pkg) {
      return jsonResponse({ error: '无效的套餐' }, 400, request)
    }
    
    // 获取 access token
    const authResponse = await fetch(`${PAYPAL_API_URL}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + btoa(clientId + ':' + clientSecret),
      },
      body: 'grant_type=client_credentials',
    })
    
    const authData = await authResponse.json()
    const accessToken = authData.access_token
    
    // 确认订单
    const captureResponse = await fetch(`${PAYPAL_API_URL}/v2/checkout/orders/${orderID}/capture`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + accessToken,
      },
    })
    
    const captureData = await captureResponse.json()
    
    if (!captureResponse.ok || captureData.status !== 'COMPLETED') {
      throw new Error(captureData.message || '支付确认失败')
    }
    
    // 获取当前次数并添加新次数
    const currentCredits = await getUserCredits(user.id, env)
    const newCredits = currentCredits + pkg.credits
    await updateUserCredits(user.id, newCredits, env)
    
    // 添加购买记录
    await addPurchaseRecord(user.id, packageId, pkg.credits, pkg.price, orderID, env)
    
    return jsonResponse({
      success: true,
      credits: newCredits,
      addedCredits: pkg.credits,
    }, 200, request)
    
  } catch (err) {
    console.error('确认 PayPal 订单失败:', err)
    return jsonResponse({ error: err.message }, 500, request)
  }
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
  
  if (url.pathname === '/api/paypal/config' && request.method === 'GET') {
    return handlePaypalConfig(request, env)
  }
  
  if (url.pathname === '/api/paypal/create-order' && request.method === 'POST') {
    return handlePaypalCreateOrder(request, env)
  }
  
  if (url.pathname === '/api/paypal/capture' && request.method === 'POST') {
    return handlePaypalCapture(request, env)
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
      oauthConfigured: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
      paypalConfigured: !!(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET),
    }, 200, request)
  }

  return new Response('Not Found', { status: 404 })
}

addEventListener('fetch', function(event) {
  event.respondWith(handleRequest(event.request, event.env))
})
