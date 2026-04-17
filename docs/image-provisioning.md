# 镜像预装 openclaw-kinthai 指南

在为客户开通服务器时，把 `@kinthaiofficial/openclaw-kinthai` 预装到镜像里可以显著提升开通速度和可靠性。

## 为什么要预装

| 维度 | 预装 | 每次 provision 现装 |
|------|------|--------------------|
| **Provision 速度** | 秒级（只需写 email） | 分钟级（下载 openclaw peer dep ~700MB） |
| **网络依赖** | 无 | 必须通 npm registry |
| **确定性** | 镜像版本固定 | npm latest 可能漂移 |
| **失败率** | 低 | 网络/超时/依赖冲突 |

## 推荐方式：openclaw 原生 install

镜像构建时（Dockerfile 或 setup-template.sh）：

```bash
# 1. 全局安装 openclaw
npm install -g openclaw@latest

# 2. 以目标用户身份初始化 openclaw（非交互）
su - oc-plugin-test -c '
  openclaw onboard --non-interactive --accept-risk
'

# 3. 安装 kinthai 插件（从 npm，装到 ~/.openclaw/extensions/kinthai/）
su - oc-plugin-test -c '
  openclaw plugins install @kinthaiofficial/openclaw-kinthai@latest --force
'
```

镜像里此时就有：
- `~/.openclaw/extensions/kinthai/`（插件代码）
- `~/.openclaw/openclaw.json`（含 `plugins.entries.kinthai.enabled = true` 和 `plugins.installs.kinthai`）
- **不写** `channels.kinthai.email`（留给 provision 时注入）

## Provision 时只需一步

每个客户开通时，通过 SSH 注入 email：

```bash
ssh ubuntu@<new-server> '
  openclaw config set channels.kinthai.email <customer_email>
  systemctl restart openclaw
'
```

或用 JSON 直接编辑（provision 脚本里常用的方式）：

```python
# services/provision/ssh.js 里的做法
python3 -c "
import json
p = '/home/ubuntu/.openclaw/openclaw.json'
cfg = json.load(open(p))
cfg.setdefault('channels', {})['kinthai'] = {'email': '${ownerEmail}'}
json.dump(cfg, open(p, 'w'), indent=2)
"
systemctl restart openclaw
```

## 版本对齐

镜像构建后，镜像里的插件版本固定。需要升级时：

1. 构建新镜像：`openclaw plugins install @kinthaiofficial/openclaw-kinthai@<new-version> --force`
2. 用新镜像开通新客户
3. 已开通的老客户：SSH 到每台机器 `openclaw plugins update kinthai`

## 不推荐：vendor 源码直接拷贝

不要直接把 `src/` 拷贝到 `~/.openclaw/extensions/kinthai/`。这绕过 openclaw 的安装记录机制（`plugins.installs.<id>`），以后升级和诊断命令（`openclaw plugins doctor`）会出问题。

## 备注

- `openclaw plugins install` 是纯磁盘操作，不需要 gateway 在线
- deviceId 在首次 agent 注册时 lazy 生成（v2.5.1+），不是安装时
- `.tokens.json` 存在 `~/.openclaw/credentials/kinthai/`，由首次 agent 注册生成，**不要**在镜像里预置
