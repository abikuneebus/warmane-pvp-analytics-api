import axios from "axios";
import * as cheerio from "cheerio";
import Bottleneck from "bottleneck";

export interface MatchSummary {
  matchId: string;
  team_name: string;
  bracket: string;
  outcome: string;
  points_change: string;
  date: string;
  duration: string;
  arena: string;
}

export interface CharacterDetail {
  realm: string;
  charname: string;
  class?: string;
  race?: string;
  gender?: string;
  teamname: string;
  teamnamerich: string;
  damageDone: string;
  deaths: string;
  healingDone: string;
  killingBlows: string;
  matchmaking_change?: string;
  personal_change: string;
}

/*
 * MatchDetails is an aggregate of all data that the crawler collects
 * for a given matchId. These objects are intended to be stored
 * long-term in some kind of database for further use and analysis.
 */
export interface MatchDetails {
  matchId: string;
  team_name: string;
  bracket: string;
  outcome: string;
  points_change: string;
  date: string;
  duration: string;
  arena: string;
  character_details: CharacterDetail[];
}

export interface Crawler {
  getMatchSummaries(params: {
    character: string;
    realm: string;
  }): Promise<MatchSummary[]>;
  getMatchDetails(params: {
    character: string;
    realm: string;
    matchSummaries: MatchSummary[];
  }): Promise<MatchDetails[]>;
}

export class WarmaneCrawler implements Crawler {
  // Fetches match history HTML w/ GET request, returns as string
  async fetchMatchHistoryHTML(params: {
    character: string;
    realm: string;
  }): Promise<string> {
    const response = await axios.get(
      `https://armory.warmane.com/character/${params.character}/${params.realm}/match-history`
    );

    return response.data;
  }

  // Extracts match summaries from match history HTML
  extractMatchSummaries(html: string): MatchSummary[] {
    const $ = cheerio.load(html);
    const matchSummaries: MatchSummary[] = [];

    $("table#data-table-history tbody tr").each((_index, element) => {
      const matchId = $(element).find("td:nth-child(1)").text().trim();
      const outcome = $(element).find("td:nth-child(3)").text().trim();
      const points_change = $(element).find("td:nth-child(4)").text().trim();
      const date = $(element).find("td:nth-child(5)").text().trim();
      const duration = $(element).find("td:nth-child(6)").text().trim();
      const arena = $(element).find("td:nth-child(7)").text().trim();
      const teamBracketText = $(element)
        .find("td:nth-child(2) a")
        .text()
        .trim();
      const teamBracketRegex = /(.*?)\s*\((\d+v\d+)\)/;
      let team_name = "";
      let bracket = "";

      if (teamBracketText) {
        const teamBracketMatch = teamBracketText.match(teamBracketRegex);

        if (teamBracketMatch) {
          team_name = teamBracketMatch[1];
          bracket = teamBracketMatch[2];
        }
      }
      const matchSummary: MatchSummary = {
        matchId,
        team_name,
        date,
        bracket,
        arena,
        points_change,
        outcome,
        duration,
      };

      matchSummaries.push(matchSummary);
    });

    return matchSummaries;
  }

  // Retrieves match summaries for specified character and realm
  async getMatchSummaries(params: {
    character: string;
    realm: string;
  }): Promise<MatchSummary[]> {
    const html = await this.fetchMatchHistoryHTML(params);
    const matchSummaries = this.extractMatchSummaries(html);
    return matchSummaries;
  }

  /*
   * Fetches match data for given match ID, character, and realm
   * Returns array of CharacterDetail objects (raw, unformatted JSON data)
   */
  async fetchMatchData(params: {
    matchId: string;
    character: string;
    realm: string;
  }): Promise<CharacterDetail[]> {
    const response = await axios.post(
      `https://armory.warmane.com/character/${params.character}/${params.realm}/match-history`,
      `matchinfo=${params.matchId}`,
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
            " Chrome/103.0.5060.114 Safari/537.36",
        },
      }
    );

    return response.data;
  }

  /*
   * Fetches match details using match IDs of each given matchSummaries array,
   * combines matchDetails objects with  corresponding matchSummary object,
   * and restricts concurrent operations to 32.
   */

  async getMatchDetails(params: {
    character: string;
    realm: string;
    matchSummaries: MatchSummary[];
  }): Promise<MatchDetails[]> {
    // extracts match IDs from 'matchSummaries' array
    const matchIds = params.matchSummaries.map((summary) => summary.matchId);
    const matchDetailsList: MatchDetails[] = [];

    // initializes and implements new Bottleneck instance to control concurrency
    const limiter = new Bottleneck({ maxConcurrent: 32 });
    const limitedFetchMatchData = limiter.wrap(this.fetchMatchData.bind(this));
    /*
     * Each match ID generates an array with a 'characterDetail'
     * object for each player in the associated match.
     */
    for (const matchId of matchIds) {
      const characterDetails = await limitedFetchMatchData({
        matchId,
        character: params.character,
        realm: params.realm,
      });

      // formats JSON response (removes HTML, organizes data )
      characterDetails.forEach((characterDetail: CharacterDetail) => {
        characterDetail.teamnamerich = characterDetail.teamnamerich.replace(
          /<[^>]+>/g,
          ""
        );

        const overallRegex = /(-?\d{1,})(?=\s*\(<span)/;
        const changeRegex = /((\+|-)\d+)(?=<\/span)/;

        // formats matchmaking_change
        if (characterDetail.matchmaking_change) {
          const mmChangeMatch =
            characterDetail.matchmaking_change.match(changeRegex);
          const mmOverallMatch =
            characterDetail.matchmaking_change.match(overallRegex);
          if (mmChangeMatch && mmOverallMatch) {
            characterDetail.matchmaking_change = `${mmChangeMatch[0]} (${mmOverallMatch[0]})`;
          }
        }

        // formats personal_change
        if (characterDetail.personal_change) {
          const personalChangeMatch =
            characterDetail.personal_change.match(changeRegex);
          const personalOverallMatch =
            characterDetail.personal_change.match(overallRegex);
          if (personalChangeMatch && personalOverallMatch) {
            characterDetail.personal_change = `${personalChangeMatch[0]} (${personalOverallMatch[0]})`;
          }
        }
      });

      // finds corresponding 'matchSummary' object
      const matchSummary = params.matchSummaries.find(
        (summary) => summary.matchId === matchId
      );

      // combines fetched match data w/ corresponding 'matchSummary' object
      if (matchSummary) {
        const matchDetails: MatchDetails = {
          ...matchSummary,
          character_details: characterDetails,
        };

        matchDetailsList.push(matchDetails);
      }
    }
    return matchDetailsList;
  }

  // allows <routes.ts> to fetch entire dataset with 'character' and 'realm' as input
  async fetchAllMatchDetails(params: {
    character: string;
    realm: string;
  }): Promise<MatchDetails[]> {
    const matchSummaries = await this.getMatchSummaries(params);
    // console.log("Match summaries fetched: ", matchSummaries);
    const matchDetailsList = await this.getMatchDetails({
      ...params,
      matchSummaries,
    });
    return matchDetailsList;
  }
}
