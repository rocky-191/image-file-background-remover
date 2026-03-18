#!/bin/bash

# Image Background Remover - 部署脚本

echo "🔧 开始部署..."

# 1. 登录 Cloudflare（如果未登录）
echo "📌 步骤 1: 登录 Cloudflare"
wrangler login

# 2. 配置环境变量
echo "📌 步骤 2: 配置环境变量"

echo "设置 GOOGLE_CLIENT_ID..."
wrangler secret put GOOGLE_CLIENT_ID

echo "设置 GOOGLE_CLIENT_SECRET..."
wrangler secret put GOOGLE_CLIENT_SECRET

echo "设置 REMOVE_BG_API_KEY..."
wrangler secret put REMOVE_BG_API_KEY

# 3. 部署
echo "📌 步骤 3: 部署 Worker"
wrangler deploy

echo "✅ 部署完成！"
