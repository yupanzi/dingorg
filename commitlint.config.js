// 版本号全由提交的 type 算（.releaserc.json），写错 type 就静默不发版，所以在 commit-msg 钩子里卡。
// subject-case 关掉：大小写对中文无意义，还会误判中英混排；CJK 占宽，行长放宽且正文只警告。
export default {
	extends: ["@commitlint/config-conventional"],
	rules: {
		"subject-case": [0],
		"header-max-length": [2, "always", 120],
		"body-max-line-length": [1, "always", 200],
		"footer-max-line-length": [1, "always", 200],
	},
};
