// Shared calendar-date grammar, including Gregorian leap years. Internal to the scalar schemas.
export const CALENDAR_DATE_PATTERN: string =
	"(?:[0-9]{2}(?:[2468][048]|[13579][26]|0[48])|(?:[02468][048]|[13579][26])00)-02-29" +
	"|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])" +
	"|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|02-(?:0[1-9]|1[0-9]|2[0-8]))";
