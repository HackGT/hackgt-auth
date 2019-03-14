// tslint:disable:interface-name
import * as crypto from "crypto";
import * as http from "http";
import * as https from "https";
import * as path from "path";
import passport from "passport";
import moment from "moment-timezone";
import uuid from "uuid/v4";

import { config, renderEmailHTML, renderEmailText, sendMailAsync, postParser } from "../common";
import { createNew, IConfig, Model, IUser, User } from "../schema";
import { Request, Response, NextFunction, Router } from "express";

import { Strategy as LocalStrategy } from "passport-local";
import { Strategy as GitHubStrategy } from "passport-github2";
import { Strategy as FacebookStrategy } from "passport-facebook";
// No type definitions available yet for these modules
// tslint:disable:no-var-requires
const GoogleStrategy: StrategyConstructor = require("passport-google-oauth20").Strategy;
const CASStrategyProvider: StrategyConstructor = require("passport-cas2").Strategy;

type Strategy = passport.Strategy & {
	logout?(request: Request, response: Response, returnURL: string): void;
};
type PassportDone = (err: Error | null, user?: Model<IUser> | false, errMessage?: { message: string }) => void;
type Profile = passport.Profile & {
	profileUrl?: string;
	_json: any;
};
interface StrategyOptions {
	passReqToCallback: true; // Forced to true for our usecase
}
interface OAuthStrategyOptions extends StrategyOptions {
	clientID: string;
	clientSecret: string;
	profileFields?: string[];
}
interface CASStrategyOptions extends StrategyOptions {
	casURL: string;
	pgtURL?: string;
	sessionKey?: string;
	propertyMap?: object;
	sslCA?: any[];
}
interface LocalStrategyOptions extends StrategyOptions {
	usernameField: string;
	passwordField: string;
}
interface StrategyConstructor {
	// OAuth constructor
	new(options: OAuthStrategyOptions, cb: (request: Request, accessToken: string, refreshToken: string, profile: Profile, done: PassportDone) => Promise<void>): Strategy;
	// CAS constructor
	new(options: CASStrategyOptions, cb: (request: Request, username: string, profile: Profile, done: PassportDone) => Promise<void>): Strategy;
}
// Because the passport typedefs don't include this for some reason
// Defined: https://github.com/jaredhanson/passport-oauth2/blob/9ddff909a992c3428781b7b2957ce1a97a924367/lib/strategy.js#L135
type AuthenticateOptions = passport.AuthenticateOptions & {
	callbackURL: string;
};

export const PBKDF2_ROUNDS: number = 300000;

export interface RegistrationStrategy {
	readonly name: string;
	readonly passportStrategy: Strategy;
	use(authRoutes: Router, scope?: string[]): void;
}
abstract class OAuthStrategy implements RegistrationStrategy {
	public readonly passportStrategy: Strategy;

	public static get defaultUserProperties() {
		return {
			"uuid": uuid(),
			"verifiedEmail": false,
			"accountConfirmed": false,

			"services": {},
		};
	}

	constructor(public readonly name: IConfig.OAuthServices, strategy: StrategyConstructor, profileFields?: string[]) {
		const secrets = config.secrets.oauth[name];
		if (!secrets || !secrets.id || !secrets.secret) {
			throw new Error(`Client ID or secret not configured in config.json or environment variables for strategy "${this.name}"`);
		}
		let options: OAuthStrategyOptions = {
			clientID: secrets.id,
			clientSecret: secrets.secret,
			profileFields,
			passReqToCallback: true
		};
		this.passportStrategy = new strategy(options, this.passportCallback.bind(this));
	}

	protected async passportCallback(request: Request, accessToken: string, refreshToken: string, profile: Profile, done: PassportDone) {
		let serviceName = this.name as IConfig.OAuthServices;

		let email: string = "";
		if (profile.emails && profile.emails.length > 0) {
			email = profile.emails[0].value.trim();
		}
		else if (!profile.emails || profile.emails.length === 0) {
			done(null, false, { message: "Your GitHub profile does not have any public email addresses. Please make an email address public before logging in with GitHub." });
			return;
		}

		let user = await User.findOne({ [`services.${this.name}.id`]: profile.id });
		if (!user) {
			user = await User.findOne({ email });
		}
		let loggedInUser = request.user as Model<IUser> | undefined;
		if (!user && !loggedInUser) {
			user = createNew<IUser>(User, {
				...OAuthStrategy.defaultUserProperties,
				email,
				name: profile.displayName ? profile.displayName.trim() : "",
				verifiedEmail: true,
			});
			if (!user.services) {
				user.services = {};
			}
			user.services[serviceName] = {
				id: profile.id,
				email,
				username: profile.username,
				profileUrl: profile.profileUrl
			};
			try {
				user.markModified("services");
				await user.save();
			}
			catch (err) {
				done(err);
				return;
			}

			done(null, user);
		}
		else {
			if (user && loggedInUser && user.uuid !== loggedInUser.uuid) {
				// Remove extra account represented by loggedInUser and merge into user
				user.services = {
					...loggedInUser.services,
					// Don't overwrite any existing services
					...user.services
				};
				if (loggedInUser.local && loggedInUser.local.hash && (!user.local || !user.local.hash)) {
					user.local = {
						...loggedInUser.local
					};
				}
				await User.findOneAndRemove({ "uuid": loggedInUser.uuid });
				// So that the user has an indication of the linking
				user.accountConfirmed = false;
			}
			else if (!user && loggedInUser) {
				// Attach service info to logged in user instead of non-existant user pulled via email address
				user = loggedInUser;
			}
			if (!user) {
				done(null, false, { "message": "Shouldn't happen: no user defined" });
				return;
			}

			if (!user.services) {
				user.services = {};
			}
			if (!user.services[serviceName]) {
				user.services[serviceName] = {
					id: profile.id,
					email,
					username: profile.username,
					profileUrl: profile.profileUrl
				};
				// So that the user has an indication of the linking
				user.accountConfirmed = false;
			}
			if (!user.verifiedEmail && user.email === email) {
				// We trust our OAuth provider to have verified the user's email for us
				user.verifiedEmail = true;
			}
			user.markModified("services");
			await user.save();
			done(null, user);
		}
	}

	public use(authRoutes: Router, scope: string[]) {
		passport.use(this.passportStrategy);

		const callbackHref = `auth/${this.name}/callback`;
		authRoutes.get(`/${this.name}`, validateAndCacheHostName, (request, response, next) => {
			let callbackURL = `${request.protocol}://${request.hostname}:${getExternalPort(request)}/${callbackHref}`;

			passport.authenticate(
				this.name,
				{ scope, callbackURL } as AuthenticateOptions
			)(request, response, next);
		});
		authRoutes.get(`/${this.name}/callback`, validateAndCacheHostName, (request, response, next) => {
			let callbackURL = `${request.protocol}://${request.hostname}:${getExternalPort(request)}/${callbackHref}`;

			passport.authenticate(
				this.name,
				{
					failureRedirect: "/login",
					successReturnToOrRedirect: "/",
					failureFlash: true,
					callbackURL
				} as AuthenticateOptions
			)(request, response, next);
		});
	}
}

export class GitHub extends OAuthStrategy {
	constructor() {
		super("github", GitHubStrategy as any);
	}
	public use(authRoutes: Router) {
		super.use(authRoutes, ["user:email"]);
	}
}

export class Google extends OAuthStrategy {
	constructor() {
		super("google", GoogleStrategy);
	}
	public use(authRoutes: Router) {
		super.use(authRoutes, ["email", "profile"]);
	}
}

export class Facebook extends OAuthStrategy {
	constructor() {
		super("facebook", FacebookStrategy as any, ["id", "displayName", "email"]);
	}
	public use(authRoutes: Router) {
		super.use(authRoutes, ["email"]);
	}
}

abstract class CASStrategy implements RegistrationStrategy {
	public readonly passportStrategy: Strategy;

	constructor(public readonly name: IConfig.CASServices, url: string, private readonly emailDomain: string) {
		this.passportStrategy = new CASStrategyProvider({
			casURL: url,
			passReqToCallback: true
		}, this.passportCallback.bind(this));
	}

	private async passportCallback(request: Request, username: string, profile: Profile, done: PassportDone) {
		// GT login will pass long invalid usernames of different capitalizations
		username = username.toLowerCase().trim();
		let loggedInUser = request.user as Model<IUser> | undefined;
		let user = await User.findOne({ [`services.${this.name}.id`]: username });
		let email = `${username}@${this.emailDomain}`;

		if (!user && !loggedInUser) {
			user = createNew<IUser>(User, {
				...OAuthStrategy.defaultUserProperties,
				email,
				name: "",
				verifiedEmail: false,
			});
			if (!user.services) {
				user.services = {};
			}
			user.services[this.name] = {
				id: username,
				email,
				username
			};
			try {
				user.markModified("services");
				await user.save();
			}
			catch (err) {
				done(err);
				return;
			}

			done(null, user);
		}
		else {
			if (user && loggedInUser && user.uuid !== loggedInUser.uuid) {
				// Remove extra account represented by loggedInUser and merge into user
				user.services = {
					...loggedInUser.services,
					// Don't overwrite any existing services
					...user.services
				};
				if (loggedInUser.local && loggedInUser.local.hash && (!user.local || !user.local.hash)) {
					user.local = {
						...loggedInUser.local
					};
				}
				await User.findOneAndRemove({ "uuid": loggedInUser.uuid });
				// So that the user has an indication of the linking
				user.accountConfirmed = false;
			}
			else if (!user && loggedInUser) {
				// Attach service info to logged in user instead of non-existant user pulled via email address
				user = loggedInUser;
			}
			if (!user) {
				done(null, false, { "message": "Shouldn't happen: no user defined" });
				return;
			}

			if (!user.services) {
				user.services = {};
			}
			if (!user.services[this.name]) {
				user.services[this.name] = {
					id: username,
					email,
					username
				};
			}
			user.markModified("services");
			await user.save();
			if (!user.verifiedEmail && user.accountConfirmed) {
				done(null, false, { "message": "You must verify your email before you can sign in" });
				return;
			}
			done(null, user);
		}
	}

	public use(authRoutes: Router) {
		passport.use(this.name, this.passportStrategy);

		authRoutes.get(`/${this.name}`, passport.authenticate(this.name, {
			failureRedirect: "/login",
			successReturnToOrRedirect: "/",
			failureFlash: true
		}));
	}
}

export class GeorgiaTechCAS extends CASStrategy {
	constructor() {
		// Registration must be hosted on a *.hack.gt domain for this to work
		super("gatech", "https://login.gatech.edu/cas", "gatech.edu");
	}
}

import * as util from "util";
const pbkdf2Async = async (password: string | Buffer, salt: string | Buffer, rounds: number): Promise<Buffer> => {
	return util.promisify(crypto.pbkdf2).call(null, password, salt, rounds, 128, "sha256");
};

export class Local implements RegistrationStrategy {
	public readonly name = "local";
	public readonly passportStrategy: Strategy;

	constructor() {
		let options: LocalStrategyOptions = {
			usernameField: "email",
			passwordField: "password",
			passReqToCallback: true
		};
		this.passportStrategy = new LocalStrategy(options, this.passportCallback.bind(this));
	}

	protected async passportCallback(request: Request, email: string, password: string, done: PassportDone) {
		email = email.trim();
		let user = await User.findOne({ email });
		if (user && request.path.match(/\/signup$/i)) {
			done(null, false, { "message": "That email address is already in use. You may already have an account from another login service." });
		}
		else if (user && !user.local!.hash) {
			done(null, false, { "message": "Please log back in with an external provider" });
		}
		else if (!user || !user.local) {
			// User hasn't signed up yet
			if (!request.path.match(/\/signup$/i)) {
				// Only create the user when targeting /signup
				done(null, false, { "message": "Incorrect email or password" });
				return;
			}
			let name: string = request.body.name || "";
			name = name.trim();
			if (!name || !email || !password) {
				done(null, false, { "message": "Missing email, name, or password" });
				return;
			}
			let salt = crypto.randomBytes(32);
			let hash = await pbkdf2Async(password, salt, PBKDF2_ROUNDS);
			user = createNew<IUser>(User, {
				...OAuthStrategy.defaultUserProperties,
				email,
				name: request.body.name,
				verifiedEmail: false,
				local: {
					"hash": hash.toString("hex"),
					"salt": salt.toString("hex"),
					"rounds": PBKDF2_ROUNDS,
				}
			});
			try {
				await user.save();
			}
			catch (err) {
				done(err);
				return;
			}
			done(null, user);
		}
		else {
			// Log the user in
			let hash = await pbkdf2Async(password, Buffer.from(user.local.salt || "", "hex"), PBKDF2_ROUNDS);
			if (hash.toString("hex") === user.local.hash) {
				if (user.verifiedEmail) {
					done(null, user);
				}
				else {
					done(null, false, { "message": "You must verify your email before you can sign in" });
				}
			}
			else {
				done(null, false, { "message": "Incorrect email or password" });
			}
		}
	}

	public use(authRoutes: Router) {
		passport.use(this.passportStrategy);

		authRoutes.post("/signup", validateAndCacheHostName, postParser, passport.authenticate("local", { failureRedirect: "/login", failureFlash: true }), (request, response) => {
			// User is logged in automatically by Passport but we want them to verify their email first
			response.redirect("/login/confirm");
		});

		authRoutes.post("/login", postParser, passport.authenticate("local", { failureRedirect: "/login", failureFlash: true, successReturnToOrRedirect: "/" }));

		authRoutes.get("/verify/:code", async (request, response) => {
			let user = await User.findOne({ "local.verificationCode": request.params.code });
			if (!user) {
				request.flash("error", "Invalid email verification code");
			}
			else {
				user.verifiedEmail = true;
				user.emailVerificationCode = undefined;
				await user.save();
				request.flash("success", "Thanks for verifying your email. You can now log in.");
			}
			response.redirect("/login");
		});

		authRoutes.post("/forgot", validateAndCacheHostName, postParser, async (request, response) => {
			let email: string | undefined = request.body.email;
			if (!email || !email.toString().trim()) {
				request.flash("error", "Invalid email");
				response.redirect("/login/forgot");
				return;
			}
			email = email.toString().trim();

			let user = await User.findOne({ email });
			if (!user) {
				request.flash("error", "No account matching the email that you submitted was found");
				response.redirect("/login/forgot");
				return;
			}
			if (!user.verifiedEmail) {
				request.flash("error", "Please verify your email first");
				response.redirect("/login");
				return;
			}
			if (!user.local || !user.local.hash) {
				request.flash("error", "The account with the email that you submitted has no password set. Please log in with an external service like GitHub, Google, or Facebook instead.");
				response.redirect("/login");
				return;
			}

			user.local.resetRequestedTime = new Date();
			user.local.resetCode = crypto.randomBytes(32).toString("hex");

			// Send reset email (hostname validated by previous middleware)
			let link = createLink(request, `/auth/forgot/${user.local.resetCode}`);
			let markdown =
				`Hi {{name}},

You (or someone who knows your email address) recently asked to reset the password for this account: {{email}}.

You can update your password by [clicking here](${link}).

If you don't use this link within ${moment.duration(config.server.passwordResetExpiration, "milliseconds").humanize()}, it will expire and you will have to [request a new one](${createLink(request, "/login/forgot")}).

If you didn't request a password reset, you can safely disregard this email and no changes will be made to your account.

Sincerely,

The ${config.server.name} Team.`;
			try {
				await user.save();
				await sendMailAsync({
					from: config.email.from,
					to: email,
					subject: `[${config.server.name}] - Password reset request`,
					html: await renderEmailHTML(markdown, user),
					text: await renderEmailText(markdown, user)
				});
				request.flash("success", "Please check your email for a link to reset your password. If it doesn't appear within a few minutes, check your spam folder.");
				response.redirect("/login/forgot");
			}
			catch (err) {
				console.error(err);
				request.flash("error", "An error occurred while sending you a password reset email");
				response.redirect("/login/forgot");
			}
		});

		authRoutes.post("/forgot/:code", validateAndCacheHostName, postParser, async (request, response) => {
			let user = await User.findOne({ "local.resetCode": request.params.code });
			if (!user) {
				request.flash("error", "Invalid password reset code");
				response.redirect("/login");
				return;
			}

			let expirationDuration = moment.duration(config.server.passwordResetExpiration, "milliseconds");
			if (!user.local || !user.local.resetCode || moment().isAfter(moment(user.local.resetRequestedTime).add(expirationDuration))) {
				request.flash("error", "Your password reset link has expired. Please request a new one.");
				if (user.local) {
					user.local.resetCode = undefined;
				}
				await user.save();
				response.redirect("/login");
				return;
			}

			let password1: string | undefined = request.body.password1;
			let password2: string | undefined = request.body.password2;
			if (!password1 || !password2) {
				request.flash("error", "Missing new password or confirm password");
				response.redirect(path.join("/auth", request.url));
				return;
			}
			if (password1 !== password2) {
				request.flash("error", "Passwords must match");
				response.redirect(path.join("/auth", request.url));
				return;
			}

			let salt = crypto.randomBytes(32);
			let hash = await pbkdf2Async(password1, salt, PBKDF2_ROUNDS);

			try {
				user.local.salt = salt.toString("hex");
				user.local.hash = hash.toString("hex");
				user.local.resetCode = undefined;
				await user.save();

				request.flash("success", "Password reset successfully. You can now log in.");
				response.redirect("/login");
			}
			catch (err) {
				console.error(err);
				request.flash("error", "An error occurred while saving your new password");
				response.redirect(path.join("/auth", request.url));
			}
		});
	}
}

export const strategies = {
	"local": Local,
	"gatech": GeorgiaTechCAS,
	"github": GitHub,
	"google": Google,
	"facebook": Facebook
};
export const prettyNames: Record<keyof typeof strategies, string> = {
	"local": "Local",
	"gatech": "Georgia Tech CAS",
	"github": "GitHub",
	"google": "Google",
	"facebook": "Facebook"
};

// Authentication helpers
function getExternalPort(request: Request): number {
	function defaultPort(): number {
		// Default ports for HTTP and HTTPS
		return request.protocol === "http" ? 80 : 443;
	}

	let host = request.headers.host;
	if (!host || Array.isArray(host)) {
		return defaultPort();
	}

	// IPv6 literal support
	let offset = host[0] === "[" ? host.indexOf("]") + 1 : 0;
	let index = host.indexOf(":", offset);
	if (index !== -1) {
		return parseInt(host.substring(index + 1), 10);
	}
	else {
		return defaultPort();
	}
}

let validatedHostNames: string[] = [];
export function validateAndCacheHostName(request: Request, response: Response, next: NextFunction) {
	// Basically checks to see if the server behind the hostname has the same session key by HMACing a random nonce
	if (validatedHostNames.find(hostname => hostname === request.hostname)) {
		next();
		return;
	}

	let nonce = crypto.randomBytes(64).toString("hex");
	function callback(message: http.IncomingMessage) {
		if (message.statusCode !== 200) {
			console.error(`Got non-OK status code when validating hostname: ${request.hostname}`);
			message.resume();
			return;
		}
		message.setEncoding("utf8");
		let data = "";
		message.on("data", (chunk) => data += chunk);
		message.on("end", () => {
			let localHMAC = crypto.createHmac("sha256", config.secrets.session).update(nonce).digest().toString("hex");
			if (localHMAC === data) {
				validatedHostNames.push(request.hostname);
				next();
			}
			else {
				console.error(`Got invalid HMAC when validating hostname: ${request.hostname}`);
			}
		});
	}
	function onError(err: Error) {
		console.error(`Error when validating hostname: ${request.hostname}`, err);
	}
	if (request.protocol === "http") {
		http.get(`http://${request.hostname}:${getExternalPort(request)}/auth/validatehost/${nonce}`, callback).on("error", onError);
	}
	else {
		https.get(`https://${request.hostname}:${getExternalPort(request)}/auth/validatehost/${nonce}`, callback).on("error", onError);
	}
}

function createLink(request: Request, link: string): string {
	if (link[0] === "/") {
		link = link.substring(1);
	}
	if ((request.secure && getExternalPort(request) === 443) || (!request.secure && getExternalPort(request) === 80)) {
		return `http${request.secure ? "s" : ""}://${request.hostname}/${link}`;
	}
	else {
		return `http${request.secure ? "s" : ""}://${request.hostname}:${getExternalPort(request)}/${link}`;
	}
}

export async function sendVerificationEmail(request: Request, user: Model<IUser>) {
	// Send verification email (hostname validated by previous middleware)
	user.emailVerificationCode = crypto.randomBytes(32).toString("hex");
	await user.save();

	let link = createLink(request, `/auth/verify/${user.emailVerificationCode}`);
	let markdown =
		`Hi {{name}},

Thanks for signing up for ${config.server.name}! To verify your email, please [click here](${link}).

Sincerely,

The ${config.server.name} Team.`;
	await sendMailAsync({
		from: config.email.from,
		to: user.email,
		subject: `[${config.server.name}] - Verify your email`,
		html: await renderEmailHTML(markdown, user),
		text: await renderEmailText(markdown, user)
	});
}