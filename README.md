# BentoPDF OFD Fork

这是一个基于 [BentoPDF](https://github.com/alam00000/bentopdf) fork 的开发版本，主要目标是在原有浏览器端 PDF 工具集里加入 **OFD to PDF** 转换能力。

原仓库 README 内容不再适合作为本 fork 的项目说明。需要了解 BentoPDF 原始项目、完整功能矩阵、自托管文档或商业授权信息时，请前往上游仓库：

- 上游项目：https://github.com/alam00000/bentopdf

## 本 Fork 做了什么

当前重点是新增 OFD 转 PDF 页面和前端转换逻辑

## 关键文件

- 页面入口：`src/pages/ofd-to-pdf.html`
- 转换逻辑：`src/js/logic/ofd-to-pdf-page.ts`
- 工具列表配置：`src/js/config/tools.ts`
- 首页搜索映射：`src/js/main.ts`
- 国际化文案：`public/locales/*/tools.json`
- OFD 解析试验脚本：`test-ofd-parse.mjs`

## 技术实现

OFD 转 PDF 当前走纯前端方案：

- 使用 `jszip` 读取 OFD 压缩包结构
- 从 `OFD.xml` 和文档 XML 中解析页面、资源、模板、绘制参数
- 将 OFD 坐标从毫米转换为 PDF points
- 使用 `pdfkit` 和 `blob-stream` 在浏览器中生成 PDF
- 使用 `@embedpdf/fonts-sc` 提供中文字体

> 说明：项目依赖里保留了 `ofd-tools`，但当前页面的核心转换逻辑主要在 `src/js/logic/ofd-to-pdf-page.ts` 中自行解析和渲染 OFD 包。

## 当前能力边界

OFD 规范比较大，当前实现优先覆盖常见版式文档的基础渲染：

- 已处理：页面尺寸、页面列表、模板页、文本对象、路径对象、PNG/JPEG 图片对象、基础颜色和透明度、部分字体映射
- 尚未完整覆盖：复杂字体度量、矢量高级属性、裁剪、变换矩阵、签章、注释、表单、特殊图像格式、完整 OFD 标准兼容性

如果某些 OFD 文件输出和原始阅读器有差异，优先从 `src/js/logic/ofd-to-pdf-page.ts` 的对象解析和绘制分支补齐。

## 开发

安装依赖：

```bash
npm install
```

启动开发服务器：

```bash
npm run dev
```

打开 Vite 输出的本地地址后访问：

```text
/ofd-to-pdf.html
```

构建：

```bash
npm run build
```

运行测试：

```bash
npm run test:run
```

如果只想快速检查 `ofd-tools` 对测试 OFD 的解析结果，可以使用：

```bash
node test-ofd-parse.mjs
```

该脚本默认读取 `public/test.ofd`。

## 部署

这个 fork 仍然沿用 BentoPDF 的 Vite 静态站点架构。构建产物位于 `dist/`，可以部署到任意静态文件服务。

### Docker / GitHub Packages

本 fork 仓库地址：

- https://github.com/cyilin36/bentopdf

GitHub Container Registry 镜像地址：

- `ghcr.io/cyilin36/bentopdf-simple:latest`

直接运行：

```bash
docker run -d \
  --name bentopdf \
  -p 3000:8080 \
  ghcr.io/cyilin36/bentopdf-simple:latest
```

开发分支镜像使用 `edge` tag：

```bash
docker run -d \
  --name bentopdf-edge \
  -p 3000:8080 \
  ghcr.io/cyilin36/bentopdf-simple:edge
```

也可以固定版本，例如：

```bash
docker pull ghcr.io/cyilin36/bentopdf-simple:v2.8.5
docker pull ghcr.io/cyilin36/bentopdf-simple:2.8.5
```

`docker-compose.yml` 示例：

```yaml
services:
  bentopdf:
    image: ghcr.io/cyilin36/bentopdf-simple:latest
    container_name: bentopdf
    ports:
      - "3000:8080"
    restart: unless-stopped
```

> `main` 分支构建会发布 `edge`；推送 `v*` tag 后会发布 `latest`、带 `v` 的版本号和不带 `v` 的版本号。

### 静态部署

生产构建：

```bash
npm run build
```

本地预览：

```bash
npm run preview
```

## License

本项目继承上游 BentoPDF 的许可证，当前 `package.json` 标记为 `AGPL-3.0-only`。详见 [LICENSE](./LICENSE)。
