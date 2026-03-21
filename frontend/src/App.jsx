import { useState, useCallback, useEffect, useRef } from 'react'

// Cloudflare Workers API 地址（部署后填入）
// 示例: https://image-bg-remover.your-account.workers.dev
const API_BASE = import.meta.env.VITE_API_BASE || ''

// 套餐配置
const PACKAGES = [
  { id: 'credits_3', name: '3次', credits: 3, price: 0.99, originalPrice: null },
  { id: 'credits_10', name: '10次', credits: 10, price: 2.99, originalPrice: null },
  { id: 'credits_50', name: '50次', credits: 50, price: 12.99, originalPrice: null },
]

function App() {
  const [image, setImage] = useState(null)
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [credits, setCredits] = useState(0)
  const [error, setError] = useState('')
  
  // 用户状态
  const [user, setUser] = useState(null)
  const [loadingUser, setLoadingUser] = useState(true)

  // 购买弹窗状态
  const [showPurchaseModal, setShowPurchaseModal] = useState(false)
  const [selectedPackage, setSelectedPackage] = useState(null)
  const [purchasing, setPurchasing] = useState(false)
  const [paypalLoaded, setPaypalLoaded] = useState(false)
  const paypalRef = useRef(null)

  // 检查用户登录状态
  useEffect(() => {
    checkUserStatus()
  }, [])

  // 加载 PayPal SDK
  useEffect(() => {
    if (showPurchaseModal && !paypalLoaded) {
      const clientId = import.meta.env.VITE_PAYPAL_CLIENT_ID
      if (!clientId) {
        console.warn('PayPal Client ID 未配置')
        return
      }
      
      const script = document.createElement('script')
      script.src = `https://www.paypal.com/sdk/js?client-id=${clientId}&currency=USD`
      script.onload = () => setPaypalLoaded(true)
      script.onerror = () => console.error('PayPal SDK 加载失败')
      document.body.appendChild(script)
    }
  }, [showPurchaseModal])

  // 渲染 PayPal 按钮
  useEffect(() => {
    if (showPurchaseModal && selectedPackage && paypalLoaded && window.paypal && paypalRef.current) {
      // 清除旧的按钮
      paypalRef.current.innerHTML = ''
      
      window.paypal.Buttons({
        style: {
          layout: 'vertical',
          color: 'blue',
          shape: 'rect',
          label: 'pay',
        },
        createOrder: (data, actions) => {
          return actions.order.create({
            purchase_units: [{
              description: `Image Background Remover - ${selectedPackage.name}`,
              amount: {
                currency_code: 'USD',
                value: selectedPackage.price.toFixed(2),
              },
            }],
          })
        },
        onApprove: async (data, actions) => {
          setPurchasing(true)
          try {
            const captureResult = await actions.order.capture()
            // 调用后端确认订单
            const response = await fetch(`${API_BASE}/api/paypal/capture`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({
                orderID: data.orderID,
                packageId: selectedPackage.id,
                credits: selectedPackage.credits,
              }),
            })
            
            if (response.ok) {
              const result = await response.json()
              setCredits(prev => prev + selectedPackage.credits)
              alert(`购买成功！已获得 ${selectedPackage.credits} 次处理次数`)
              setShowPurchaseModal(false)
              setSelectedPackage(null)
            } else {
              throw new Error('订单确认失败')
            }
          } catch (err) {
            console.error('支付确认失败:', err)
            alert('支付确认失败，请联系客服处理')
          } finally {
            setPurchasing(false)
          }
        },
        onError: (err) => {
          console.error('PayPal error:', err)
          alert('支付失败，请重试')
        },
      }).render(paypalRef.current)
    }
  }, [showPurchaseModal, selectedPackage, paypalLoaded])

  const checkUserStatus = async () => {
    if (!API_BASE) {
      setLoadingUser(false)
      return
    }
    
    try {
      const response = await fetch(`${API_BASE}/api/user`, {
        credentials: 'include',
      })
      const data = await response.json()
      
      if (data.loggedIn) {
        setUser(data.user)
        setCredits(data.usage?.remaining || 0)
      } else {
        setCredits(3) // 未登录用户每天 3 次
      }
    } catch (err) {
      console.error('获取用户状态失败:', err)
      setCredits(3)
    } finally {
      setLoadingUser(false)
    }
  }

  // 登录
  const handleLogin = () => {
    if (!API_BASE) {
      alert('请先配置 API_BASE 环境变量并部署')
      return
    }
    window.location.href = `${API_BASE}/login`
  }

  // 登出
  const handleLogout = async () => {
    if (!API_BASE) return
    
    try {
      await fetch(`${API_BASE}/logout`, {
        credentials: 'include',
        redirect: 'manual',
      })
      setUser(null)
      setCredits(3)
      window.location.href = '/'
    } catch (err) {
      console.error('登出失败:', err)
    }
  }

  // 处理拖拽
  const handleDrag = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true)
    } else if (e.type === 'dragleave') {
      setDragActive(false)
    }
  }, [])

  // 处理文件上传
  const handleDrop = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(false)
    setError('')
    
    const files = e.dataTransfer?.files
    if (files && files[0]) {
      processFile(files[0])
    }
  }, [])

  // 处理文件选择
  const handleFileSelect = (e) => {
    setError('')
    const files = e.target.files
    if (files && files[0]) {
      processFile(files[0])
    }
  }

  // 处理文件
  const processFile = (file) => {
    // 验证文件类型
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError('仅支持 JPG, PNG, WebP 格式')
      return
    }
    
    // 验证文件大小 (10MB)
    if (file.size > 10 * 1024 * 1024) {
      setError('图片大小不能超过 10MB')
      return
    }

    // 验证最小尺寸
    const img = new Image()
    img.onload = () => {
      if (img.width < 50 || img.height < 50) {
        setError('图片尺寸不能小于 50x50 像素')
        return
      }
      if (img.width > 8000 || img.height > 8000) {
        setError('图片尺寸不能超过 8000x8000 像素')
        return
      }
    }
    img.src = URL.createObjectURL(file)

    // 读取文件
    const reader = new FileReader()
    reader.onload = (e) => {
      setImage(e.target.result)
      setResult(null)
    }
    reader.readAsDataURL(file)
  }

  // 去除背景 - 调用真实 API
  const removeBackground = async () => {
    if (!image) return
    
    // 需要登录才能使用
    if (!user) {
      alert('请先登录后再使用')
      return
    }
    
    // 检查次数
    if (credits <= 0) {
      setShowPurchaseModal(true)
      return
    }
    
    setLoading(true)
    setError('')
    
    try {
      // 将 base64 转为 Blob
      const response = await fetch(image)
      const blob = await response.blob()
      
      // 调用 Remove.bg API
      const formData = new FormData()
      formData.append('image_file', blob, 'image.png')
      formData.append('size', 'auto')

      // 如果没有配置 API_BASE，使用模拟处理
      if (!API_BASE) {
        // 模拟 API 调用
        await new Promise(resolve => setTimeout(resolve, 2000))
        setResult(image)
        setCredits(prev => prev - 1)
        
        alert('⚠️ API 未配置，当前为模拟处理。\n\n请部署 Cloudflare Workers 并配置 Remove.bg API Key。')
      } else {
        // 调用真实 API
        const apiResponse = await fetch(`${API_BASE}/api/remove-bg`, {
          method: 'POST',
          credentials: 'include',
          body: formData,
        })

        if (!apiResponse.ok) {
          const errorData = await apiResponse.json()
          if (errorData.error === '次数用完') {
            setCredits(0)
            setShowPurchaseModal(true)
            throw new Error('今日免费次数已用完，请购买更多次数')
          }
          throw new Error(errorData.error || 'API 调用失败')
        }

        // 获取处理后的图片
        const resultBlob = await apiResponse.blob()
        const resultUrl = URL.createObjectURL(resultBlob)
        
        setResult(resultUrl)
        setCredits(prev => prev - 1)
      }
    } catch (err) {
      console.error('处理失败:', err)
      setError('处理失败，请重试: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  // 下载图片
  const downloadImage = () => {
    if (!result) return
    
    const link = document.createElement('a')
    link.href = result
    link.download = `remove-bg-${Date.now()}.png`
    link.click()
  }

  // 重新上传
  const reset = () => {
    setImage(null)
    setResult(null)
    setError('')
  }

  // 打开购买弹窗
  const openPurchaseModal = (pkg = null) => {
    if (!user) {
      alert('请先登录后再购买')
      handleLogin()
      return
    }
    setSelectedPackage(pkg || PACKAGES[1]) // 默认选10次
    setShowPurchaseModal(true)
  }

  return (
    <div className="min-h-screen pb-16">
      {/* Header */}
      <header className="bg-white shadow-sm">
        <div className="max-w-4xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="text-center flex-1">
              <h1 className="text-xl font-semibold text-gray-800">
                🖼️ Image Background Remover
              </h1>
              <p className="text-sm text-gray-500 mt-1">
                AI 一键去除图片背景
              </p>
              <p className="text-xs text-gray-400">
                AI-powered background removal in one click
              </p>
            </div>
            
            {/* 用户区域 */}
            <div className="flex items-center gap-2">
              {loadingUser ? (
                <span className="text-sm text-gray-400">加载中...</span>
              ) : user ? (
                <div className="flex items-center gap-2">
                  <img 
                    src={user.picture} 
                    alt={user.name}
                    className="w-8 h-8 rounded-full"
                  />
                  <span className="text-sm text-gray-600">{user.name}</span>
                  <button
                    onClick={handleLogout}
                    className="text-sm text-gray-400 hover:text-gray-600"
                  >
                    登出
                  </button>
                </div>
              ) : (
                <button
                  onClick={handleLogin}
                  className="text-sm bg-blue-500 text-white px-3 py-1.5 rounded-lg hover:bg-blue-600"
                >
                  Google 登录
                </button>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-4xl mx-auto px-4 py-8">
        {!image ? (
          // 上传区域
          <div
            className={`border-2 border-dashed rounded-xl p-12 text-center transition-colors ${
              dragActive 
                ? 'border-blue-500 bg-blue-50' 
                : 'border-gray-300 hover:border-gray-400'
            }`}
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
          >
            <div className="text-6xl mb-4">📁</div>
            <p className="text-gray-600 mb-2">
              拖拽图片到此处，或点击选择文件
            </p>
            <p className="text-gray-400 text-sm mb-4">
              支持 JPG, PNG, WebP，最大 10MB
            </p>
            <label className="inline-block px-6 py-3 bg-blue-500 text-white rounded-lg cursor-pointer hover:bg-blue-600 transition-colors">
              选择文件
              <input 
                type="file" 
                className="hidden" 
                accept="image/jpeg,image/png,image/webp"
                onChange={handleFileSelect}
              />
            </label>
            
            {/* 错误提示 */}
            {error && (
              <p className="mt-4 text-red-500">{error}</p>
            )}
          </div>
        ) : (
          // 处理/结果区域
          <div>
            {/* 预览区域 */}
            <div className="grid grid-cols-2 gap-4 mb-6">
              <div className="bg-white rounded-xl p-4 shadow-sm">
                <p className="text-gray-500 text-sm mb-2">原图</p>
                <img 
                  src={image} 
                  alt="Original" 
                  className="w-full rounded-lg"
                />
              </div>
              <div className="bg-white rounded-xl p-4 shadow-sm">
                <p className="text-gray-500 text-sm mb-2">
                  结果 {result && '✅'}
                </p>
                {result ? (
                  <img 
                    src={result} 
                    alt="Result" 
                    className="w-full rounded-lg"
                  />
                ) : (
                  <div className="w-full aspect-square bg-gray-100 rounded-lg flex items-center justify-center">
                    {loading ? (
                      <div className="text-center">
                        <div className="animate-spin text-3xl mb-2">⏳</div>
                        <p className="text-gray-500">正在去除背景...</p>
                      </div>
                    ) : (
                      <span className="text-gray-400">等待处理...</span>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* 错误提示 */}
            {error && (
              <p className="text-red-500 text-center mb-4">{error}</p>
            )}

            {/* 操作按钮 */}
            <div className="flex items-center justify-center gap-4">
              {!result ? (
                <>
                  <button
                    onClick={removeBackground}
                    disabled={loading}
                    className={`px-8 py-3 rounded-lg font-medium transition-colors ${
                      loading
                        ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                        : 'bg-blue-500 text-white hover:bg-blue-600'
                    }`}
                  >
                    {loading ? '处理中...' : '去除背景'}
                  </button>
                  <button
                    onClick={reset}
                    disabled={loading}
                    className="px-6 py-3 bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200 transition-colors disabled:opacity-50"
                  >
                    重新选择
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={downloadImage}
                    className="px-8 py-3 bg-green-500 text-white rounded-lg font-medium hover:bg-green-600 transition-colors"
                  >
                    📥 下载图片
                  </button>
                  <button
                    onClick={reset}
                    className="px-6 py-3 bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200 transition-colors"
                  >
                    🔄 继续处理
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {/* 剩余次数 */}
        <div className="mt-8 text-center">
          <p className="text-gray-500">
            今日剩余免费次数：<span className="font-semibold text-blue-500">{credits}</span> 次
            {credits === 0 && (
              <span className="ml-2 text-orange-500">
                （次数已用完）
              </span>
            )}
          </p>
          {credits === 0 && !user && (
            <p className="text-sm text-gray-400 mt-2">
              登录后可获得更多次数
            </p>
          )}
          {credits === 0 && user && (
            <button
              onClick={() => openPurchaseModal()}
              className="mt-2 px-4 py-2 bg-orange-500 text-white text-sm rounded-lg hover:bg-orange-600 transition-colors"
            >
              购买更多次数
            </button>
          )}
          {credits > 0 && credits < 3 && user && (
            <button
              onClick={() => openPurchaseModal()}
              className="mt-2 px-4 py-2 bg-gray-100 text-gray-600 text-sm rounded-lg hover:bg-gray-200 transition-colors"
            >
              购买更多次数
            </button>
          )}
        </div>
      </main>

      {/* 购买弹窗 */}
      {showPurchaseModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-semibold text-gray-800">购买处理次数</h2>
              <button
                onClick={() => {
                  setShowPurchaseModal(false)
                  setSelectedPackage(null)
                }}
                className="text-gray-400 hover:text-gray-600 text-2xl"
              >
                ×
              </button>
            </div>
            
            {/* 套餐选择 */}
            <div className="space-y-3 mb-6">
              {PACKAGES.map((pkg) => (
                <div
                  key={pkg.id}
                  onClick={() => setSelectedPackage(pkg)}
                  className={`p-4 rounded-xl border-2 cursor-pointer transition-colors ${
                    selectedPackage?.id === pkg.id
                      ? 'border-blue-500 bg-blue-50'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <div className="flex justify-between items-center">
                    <div>
                      <span className="font-semibold text-gray-800">{pkg.name}</span>
                      <span className="text-gray-500 ml-2">{pkg.credits} 次处理</span>
                    </div>
                    <div className="text-right">
                      <span className="text-xl font-bold text-blue-600">${pkg.price}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            
            {/* PayPal 按钮 */}
            <div className="mb-4">
              {purchasing ? (
                <div className="text-center py-4">
                  <div className="animate-spin text-3xl mb-2">⏳</div>
                  <p className="text-gray-500">处理中...</p>
                </div>
              ) : (
                <>
                  {!selectedPackage && (
                    <p className="text-center text-gray-500 py-4">请选择套餐</p>
                  )}
                  <div ref={paypalRef} className={!selectedPackage ? 'hidden' : ''}></div>
                </>
              )}
            </div>
            
            <p className="text-center text-xs text-gray-400">
              支付成功后次数将自动添加到您的账户
            </p>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="fixed bottom-0 left-0 right-0 bg-white border-t py-4">
        <div className="max-w-4xl mx-auto px-4 text-center text-gray-400 text-sm">
          © 2026 Image Background Remover
        </div>
      </footer>
    </div>
  )
}

export default App
