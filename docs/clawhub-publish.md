# ClawHub 发布指南

发布 `@kinthaiofficial/openclaw-kinthai` 到 ClawHub。

## 前提

- 开发机（10.8.0.13）已安装 `clawhub` CLI（v0.9.0）
- 已登录：token 存在 `~/.config/clawhub/config.json`
- 代码已提交并 push 到 GitHub main

## 发布命令

```bash
cd /root/public/openclaw-kinthai

# 获取当前版本
VERSION=$(python3 -c "import json;print(json.load(open('package.json'))['version'])")
COMMIT=$(git rev-parse HEAD)

# 发布
clawhub package publish . \
  --family code-plugin \
  --name "@kinthaiofficial/openclaw-kinthai" \
  --display-name "KinthAI" \
  --version "$VERSION" \
  --source-repo kinthaiofficial/openclaw-kinthai \
  --source-commit "$COMMIT" \
  --source-ref main \
  --no-input
```

## 验证

```bash
# 查看已发布版本
clawhub package inspect @kinthaiofficial/openclaw-kinthai
```

## 注意事项

- ClawHub 发布和 npm 发布是**独立的**，需要分别执行
- npm 发布：`cd /root/public/openclaw-kinthai && npm publish --access public`
- 先发 npm，再发 ClawHub（顺序无强制要求，但 npm 是主分发渠道）
- `--no-input` 跳过交互确认，适合脚本调用
- token 过期时用 `clawhub login` 重新登录（会打开浏览器）

## 完整发布流程

```bash
# 1. 确认版本和代码
cd /root/public/openclaw-kinthai
git status  # 确保工作树干净
VERSION=$(python3 -c "import json;print(json.load(open('package.json'))['version'])")
echo "Publishing v$VERSION"

# 2. npm 发布
npm publish --access public

# 3. ClawHub 发布
clawhub package publish . \
  --family code-plugin \
  --name "@kinthaiofficial/openclaw-kinthai" \
  --display-name "KinthAI" \
  --version "$VERSION" \
  --source-repo kinthaiofficial/openclaw-kinthai \
  --source-commit "$(git rev-parse HEAD)" \
  --source-ref main \
  --no-input

# 4. 验证
npm view @kinthaiofficial/openclaw-kinthai version
clawhub package inspect @kinthaiofficial/openclaw-kinthai
```
