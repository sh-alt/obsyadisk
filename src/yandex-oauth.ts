import { requestUrl } from "obsidian";

/**
 * Yandex OAuth 2.0 flow for Obsidian.
 *
 * Uses the authorization-code flow with PKCE (RFC 7636): Yandex redirects to
 * obsidian://obsyadisk-auth?code=CODE — a query-string param, reliably parsed by
 * Obsidian's protocol handler. (The implicit/token flow was tried instead, but Yandex
 * returns access_token via URL fragment per spec, which Obsidian's handler never sees —
 * that's why it looked like nothing came back at all.) PKCE's code_verifier lets the
 * token exchange skip client_secret, which the bundled OAuth app (a confidential
 * client) would otherwise require and which can't be shipped in a public repo.
 *
 * For this to work, you need to register an OAuth app at https://oauth.yandex.ru/client/new:
 *   - Platform: "Web services"
 *   - Redirect URI: obsidian://obsyadisk-auth
 *   - Scopes: cloud_api:disk.read, cloud_api:disk.write, cloud_api:disk.app_folder
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
	/** PKCE verifier for the in-flight authorization attempt, set by getAuthorizeUrl(). */
	private codeVerifier: string | null = null;

	constructor(config: OAuthConfig) {
		this.config = config;
	}

	/**
	 * Build the authorization URL that opens in the user's browser, generating a fresh
	 * PKCE code_verifier/code_challenge pair for this attempt.
	 */
	private async getAuthorizeUrl(): Promise<string> {
		this.codeVerifier = this.generateCodeVerifier();
		const codeChallenge = await this.sha256Base64Url(this.codeVerifier);
		const params = new URLSearchParams({
			response_type: "code",
			client_id: this.config.clientId,
			redirect_uri: OBSIDIAN_REDIRECT_URI,
			force_confirm: "yes",
			code_challenge: codeChallenge,
			code_challenge_method: "S256",
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
		if (this.codeVerifier) {
			// PKCE: code_verifier proves possession of the original request, so
			// Yandex accepts it in place of client_secret for this exchange.
			body.set("code_verifier", this.codeVerifier);
		} else if (this.config.clientSecret) {
			body.set("client_secret", this.config.clientSecret);
		}

		const resp = await requestUrl({
			url: YANDEX_TOKEN_URL,
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: body.toString(),
			throw: false,  // don't throw on 4xx — return JSON error body instead
		});

		return resp.json as OAuthTokenResponse;
	}

	/** Open the authorization page in the system browser. */
	async openAuthPage(): Promise<void> {
		window.open(await this.getAuthorizeUrl());
	}

	private generateCodeVerifier(): string {
		const bytes = new Uint8Array(32);
		crypto.getRandomValues(bytes);
		return this.base64UrlEncode(bytes);
	}

	private async sha256Base64Url(input: string): Promise<string> {
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
		return this.base64UrlEncode(new Uint8Array(digest));
	}

	private base64UrlEncode(bytes: Uint8Array): string {
		let binary = "";
		for (const b of bytes) binary += String.fromCharCode(b);
		return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	}
}
