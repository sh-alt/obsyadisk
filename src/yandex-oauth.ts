import { requestUrl, Platform } from "obsidian";

/**
 * Yandex OAuth 2.0 flow for Obsidian.
 *
 * Flow:
 * 1. User clicks "Авторизоваться" → opens browser at Yandex authorize URL
 * 2. Yandex redirects to obsidian://obsyadisk-auth?code=CODE
 * 3. Obsidian catches the URI, plugin exchanges code → token via POST
 *
 * For this to work, you need to register an OAuth app at https://oauth.yandex.ru/client/new:
 *   - Platform: "Web services"
 *   - Redirect URI: https://oauth.yandex.ru/verification_code  (for device flow fallback)
 *   - Redirect URI: obsidian://obsyadisk-auth  (for automatic flow)
 *   - Scopes: cloud_api:disk.read, cloud_api:disk.write, cloud_api:disk.app_folder
 *
 * After registration you get a client_id (and optionally client_secret).
 * The client_id should be hardcoded or configurable.
 */

const YANDEX_AUTHORIZE_URL = "https://oauth.yandex.ru/authorize";
const YANDEX_TOKEN_URL = "https://oauth.yandex.ru/token";

/** Default redirect using obsidian:// protocol — works on both desktop and mobile */
const OBSIDIAN_REDIRECT_URI = "obsidian://obsyadisk-auth";

/** Bundled OAuth app client ID — users don't need to register their own app */
export const BUNDLED_CLIENT_ID = "284899b00eb84c77bf1091e65b4bd5ee";

export interface OAuthConfig {
	clientId: string;
	clientSecret: string;
}

export interface OAuthTokenResponse {
	access_token: string;
	token_type: string;
	expires_in: number;
	refresh_token?: string;
	error?: string;
	error_description?: string;
}

export class YandexOAuth {
	private config: OAuthConfig;

	constructor(config: OAuthConfig) {
		this.config = config;
	}

	/**
	 * Build the authorization URL that opens in the user's browser.
	 * Uses `response_type=code` for the authorization code flow.
	 */
	getAuthorizeUrl(): string {
		const params = new URLSearchParams({
			response_type: "code",
			client_id: this.config.clientId,
			redirect_uri: OBSIDIAN_REDIRECT_URI,
			force_confirm: "yes",
		});
		return `${YANDEX_AUTHORIZE_URL}?${params.toString()}`;
	}

	/**
	 * Build the authorization URL for device/token flow.
	 * Returns token directly in the URL fragment — used as fallback
	 * when obsidian:// redirect doesn't work.
	 */
	getAuthorizeUrlTokenFlow(): string {
		const params = new URLSearchParams({
			response_type: "token",
			client_id: this.config.clientId,
			force_confirm: "yes",
		});
		return `${YANDEX_AUTHORIZE_URL}?${params.toString()}`;
	}

	/**
	 * Exchange authorization code for an access token.
	 * Called after Yandex redirects back to obsidian://obsyadisk-auth?code=CODE
	 */
	async exchangeCodeForToken(code: string): Promise<OAuthTokenResponse> {
		const body = new URLSearchParams({
			grant_type: "authorization_code",
			code,
			client_id: this.config.clientId,
			redirect_uri: OBSIDIAN_REDIRECT_URI,
		});
		// client_secret is optional for native/desktop apps in Yandex OAuth
		if (this.config.clientSecret) {
			body.set("client_secret", this.config.clientSecret);
		}

		const resp = await requestUrl({
			url: YANDEX_TOKEN_URL,
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: body.toString(),
		});

		return resp.json as OAuthTokenResponse;
	}

	/**
	 * Open the authorization page in the system browser.
	 * On desktop: authorization code flow (code → exchange → token).
	 * On mobile: implicit/token flow (token returned directly in URL).
	 *   Mobile browsers/WebViews may not handle the code exchange POST correctly,
	 *   so we use response_type=token which returns access_token directly via redirect.
	 */
	openAuthPage(): void {
		const url = Platform.isMobile
			? this.getAuthorizeUrlTokenFlow()
			: this.getAuthorizeUrl();
		window.open(url);
	}
}
