# Image Background Remover

在线图片背景去除工具 - MVP

## 技术栈

- **前端**: React + Vite + Tailwind CSS
- **后端**: Cloudflare Workers
- **API**: Remove.bg

## 功能

- [x] 图片上传（拖拽/点击）
- [x] 背景去除
- [x] 结果预览对比
- [x] PNG 下载
- [x] 免费次数限制

## 快速开始

### 前端开发

```bash
cd frontend
npm install
npm run dev
```

### 部署

#### 前端 (Cloudflare Pages)

```bash
npm run build
wrangler pages deploy dist
```

#### 后端 (Cloudflare Workers)

```bash
cd workers
wrangler deploy
```

## 定价

### 免费版
- 每天 3 次

### 付费版 (v1.2)
- 次卡: $0.99 / 40次
- 月卡: $4.99 / 400次  
- 年卡: $49.99 / 无限

## License

MIT
