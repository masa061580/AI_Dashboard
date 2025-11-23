# AI Dashboard

Chrome拡張機能：複数のAIサービス（ChatGPT、Claude、Gemini、NotebookLM）のサイドパネル統合管理

## 機能

- 複数のAIサービスをサイドパネルから一元的に管理
- AI生成状況の検知と視覚的フィードバック
- バックグラウンドでの完了通知
- 通知音の再生
- タブ一覧とステータス表示

## 対応サービス

- ChatGPT (chatgpt.com, chat.openai.com)
- Claude (claude.ai)
- Gemini (gemini.google.com)
- NotebookLM (notebooklm.google.com)

## インストール方法

1. このリポジトリをクローンまたはダウンロード
2. Chromeを開き、`chrome://extensions/` にアクセス
3. 「デベロッパーモード」を有効化
4. 「パッケージ化されていない拡張機能を読み込む」をクリック
5. このフォルダを選択

## ファイル構成

### 必須ファイル

- `manifest.json` - 拡張機能の設定ファイル
- `background.js` - バックグラウンドスクリプト（サービスワーカー）
- `content.js` - ChatGPT/NotebookLM用コンテンツスクリプト
- `original_content_claude_gemini.js` - Claude/Gemini用コンテンツスクリプト
- `sidepanel.html` - サイドパネルUI
- `sidepanel.js` - サイドパネルのロジック
- `sidepanel.css` - サイドパネルのスタイル
- `offscreen.html` - 音声再生用オフスクリーンドキュメント
- `offscreen.js` - 音声再生スクリプト
- `rules.json` - ネットワークリクエストルール
- `icons/icon16.png` - 16x16アイコン
- `icons/icon48.png` - 48x48アイコン
- `icons/icon128.png` - 128x128アイコン

## 使用方法

1. 拡張機能をインストール後、Chromeのツールバーにアイコンが表示されます
2. アイコンをクリックしてサイドパネルを開きます
3. サイドパネルから各AIサービスを起動できます
4. 生成中は赤枠、完了時は緑枠が表示されます（設定で無効化可能）
5. バックグラウンドタブでも完了通知が表示されます

## 対応OS

- Windows
- macOS
- Linux（Chromeがインストールされている場合）

## ライセンス

このプロジェクトは個人利用目的で作成されています。

## 更新履歴

### v1.1 (2025-11-23)
- **NotebookLM対応強化**: 生成状態（思考中/完了）の検知精度を向上させました。
- **UI改善**:
  - サイドパネルのレイアウトをコンパクト化し、狭い幅でも見やすく調整。
  - サービス起動アイコンを横1列（4列）配置に変更。
  - NotebookLMのアイコンを更新。
- **タブ管理機能の強化**:
  - 管理可能なタブ数の上限を6個から10個に拡大。
  - サイドパネルのタブクリック時に、対象のウィンドウを最前面に表示する機能を追加。
  - 閉じたタブがカウントに残る不具合を修正。
- **その他**:
  - Gemini/Claudeでの赤枠・緑枠表示を無効化（設定変更）。
  - コンソールエラーの修正。
