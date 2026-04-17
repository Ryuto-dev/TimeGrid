# TimeGrid - タイムスケジュール管理アプリ

TimeGridは、複数ユーザーがリアルタイムで共同編集できるタイムスケジュール管理ウェブアプリケーションです。
イベント運営、学園祭、会議進行、シフト管理など、時間と場所（ステージ・部屋など）の軸を持つ予定を
グリッド形式で視覚的に管理できます。

## 主な機能

- 🗂 **グリッドベースの編集**: 時間（縦軸）× 場所（横軸）の直感的なUI
- 🖱 **ドラッグ＆ドロップ**: 予定の移動・時間伸縮・列間移動が可能
- 👥 **共同編集（リアルタイム同期）**: 他のユーザーの変更が数秒で自動反映されます
- 📍 **場所のカスタマイズ**: 列の追加・並び替え・色変更が可能（複数場所にまたがる予定も可）
- ⚡ **タスクと期間**: 時間幅のある「期間」イベントと、開始時刻のみの「タスク」マーカーを使い分け
- 📱 **PWA対応**: ホーム画面にインストールしてオフライン閲覧も可能
- 📝 **備考列 / 自動テキストカラー / 時計ライン / 印刷対応 / JSONエクスポート**
- ⌨️ **キーボードショートカット**: `N`=新規, `Esc`=モーダル閉じる, `Ctrl+P`=印刷

## アーキテクチャ

**ピュアな静的＋PHPアーキテクチャ**。Node.js 等のプロセス常駐型サーバーは不要です。

| レイヤー | 技術 |
| -------- | ---- |
| フロントエンド | Vanilla JavaScript (ES2020) / CSS3 / HTML5 |
| バックエンド | 単一ファイルの PHP API (`api.php`) |
| データストレージ | ファイルベース JSON (排他ロック付き) |
| リアルタイム同期 | 変更ログのロングポーリング (`?action=changes&since=...`) |
| オフライン対応 | Service Worker + Web App Manifest |

PHP 7.4+ が動く **共有ホスティング（cloudfree.jp 等）にそのままアップロード** するだけで動作します。

## ディレクトリ構成

```
public/
├── index.html            # アプリシェル
├── api.php               # 単一ファイルのバックエンドAPI
├── manifest.webmanifest  # PWA manifest
├── sw.js                 # Service Worker
├── .htaccess             # Apache 設定（MIME / セキュリティヘッダ / 期限）
├── css/style.css
├── js/
│   ├── api.js            # API クライアント + ポーリングシンク
│   ├── state.js          # アプリ内ステート
│   ├── timeline.js       # タイムラインレンダラ
│   ├── events.js         # イベント CRUD / D&D / リサイズ
│   └── app.js            # ルーティング / モーダル / PWA 登録
├── icons/                # PWAアイコン（SVG + PNG）
└── data/                 # サーバー書き込み先（本番では自動生成）
    └── .htaccess         # 直接アクセス禁止
```

## ローカルでの動作確認

```bash
# PHP 7.4+ がインストールされていれば組み込みサーバーで起動できます
php -S localhost:8080 -t public
```
ブラウザで <http://localhost:8080/> を開いてください。

## デプロイ（cloudfree.jp 等の共有ホスティング）

1. `public/` 配下のファイルを FTP/SFTP でサーバーの公開ディレクトリにアップロード
2. サーバーで `public/data/` ディレクトリに**書き込み権限**があることを確認（通常 `755` / `775`）
3. ブラウザでアクセス → 自動的に `data/db.json` と `data/changes.json` が生成されます

> ℹ️ このリポジトリには GitHub Actions による **FTP自動デプロイ** が設定されています（`.github/workflows/deploy.yml`）。
> `main` ブランチへの push で自動反映されます。

### サーバー側で保存されるファイル（自動生成）

| ファイル | 役割 |
| -------- | ---- |
| `data/db.json` | 全スケジュール / 場所 / 予定のデータ |
| `data/changes.json` | 変更ログ（最新500件まで自動トリム） |
| `data/db.lock` | 書き込み時の排他ロック |

`data/` 内の `.htaccess` により、これらのファイルは直接ダウンロードできません。

## セキュリティ

- `.htaccess` で `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` 等のセキュリティヘッダを付与
- すべてのユーザー入力はサーバー側で型・長さ・カラーコード形式をバリデーション
- `place_ids` は該当スケジュールに属する場所 ID のみ受理
- データファイル (`db.json` 等) は `.htaccess` により直接アクセス不可
- XSS 対策: フロントエンドは `textContent` / `escHtml()` で挿入

## ブラウザサポート

モダンブラウザ（Chrome, Edge, Firefox, Safari, iOS Safari）。Service Worker は HTTPS（または `localhost`）で有効化されます。

## ライセンス

MIT
