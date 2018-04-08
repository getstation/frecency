// @flow

import type {FrecencyData, FrecencyOptions, SaveParams, SortParams} from './types';

class Frecency {
  // Used to create key that will be used to save frecency data in localStorage.
  _resourceType: string;
  // Max number of timestamps to save for recent selections of a result.
  _timestampsLimit: number;
  // Max number of IDs that should be stored in frecency to limit the object size.
  _recentSelectionsLimit: number;

  _frecency: FrecencyData;

  constructor({ resourceType, timestampsLimit, recentSelectionsLimit }: FrecencyOptions) {
    if (!resourceType) throw new Error('Resource type is required.');

    this._resourceType = resourceType;
    this._timestampsLimit = timestampsLimit || 10;
    this._recentSelectionsLimit = recentSelectionsLimit || 100;

    this._frecency = this._getFrecencyData();
  }

  save({ searchQuery, selectedId }: SaveParams): void {
    if (!searchQuery || !selectedId) return;

    const now = Date.now();
    const frecency = this._getFrecencyData();

    this._updateFrecencyByQuery(frecency, searchQuery, selectedId, now);
    this._updateFrecencyById(frecency, searchQuery, selectedId, now);

    this._cleanUpOldSelections(frecency, selectedId);
    this._saveFrecencyData(frecency);
    this._frecency = frecency;
  }

  _getFrecencyKey(): string {
    return `frecency_${this._resourceType}`;
  }

  _getFrecencyData(): FrecencyData {
    const defaultFrecency = {
      queries: {},
      selections: {},
      recentSelections: []
    };

    const savedData = localStorage.getItem(this._getFrecencyKey());
    return savedData ? JSON.parse(savedData) : defaultFrecency;
  }

  _saveFrecencyData(frecency: FrecencyData): void {
    localStorage.setItem(this._getFrecencyKey(), JSON.stringify(frecency));
  }

  _updateFrecencyByQuery(frecency: FrecencyData, searchQuery: string, selectedId: string,
    now: number): void {

    const queries = frecency.queries;
    if (!queries[searchQuery]) queries[searchQuery] = [];

    const previousSelection = queries[searchQuery].find((selection) => {
      return selection.id === selectedId;
    });

    // If this ID was not selected previously for this search query, we'll
    // create a new entry.
    if (!previousSelection) {
      queries[searchQuery].push({
        id: selectedId,
        timesSelected: 1,
        selectedAt: [now]
      });
      return;
    }

    // Otherwise, increment the previous entry.
    previousSelection.timesSelected += 1;
    previousSelection.selectedAt.push(now);

    // Limit the recent selections timestamps.
    previousSelection.selectedAt = previousSelection.selectedAt
      .slice(1, this._timestampsLimit + 1);
  }

  _updateFrecencyById(frecency: FrecencyData, searchQuery: string, selectedId: string,
    now: number): void {

    const selections = frecency.selections;
    const previousSelection = selections[selectedId];

    // If this ID was not selected previously, we'll create a new entry.
    if (!previousSelection) {
      selections[selectedId] = {
        timesSelected: 1,
        selectedAt: [now],
        queries: { [searchQuery]: true }
      };
      return;
    }

    // Otherwise, update the previous entry.
    previousSelection.timesSelected += 1;
    previousSelection.selectedAt.push(now);

    // Limit the recent selections timestamps.
    previousSelection.selectedAt = previousSelection.selectedAt
      .slice(1, this._timestampsLimit + 1);

    // Remember which search queries this result was selected for so we can
    // remove this result from frecency later when cleaning up.
    previousSelection.queries[searchQuery] = true;
  }

  _cleanUpOldSelections(frecency: FrecencyData, selectedId: string): void {
    const recentSelections = frecency.recentSelections;

    // If frecency already contains the selected ID, shift it to the front.
    if (recentSelections.includes(selectedId)) {
      frecency.recentSelections = [
        selectedId,
        ...recentSelections.filter((id) => id !== selectedId)
      ];
      return;
    }

    // Otherwise add the selected ID to the front of the list.
    if (recentSelections.length < this._recentSelectionsLimit) {
      frecency.recentSelections = [
        selectedId,
        ...recentSelections
      ];
      return;
    }

    // If the number of recent selections has gone over the limit, we'll remove
    // the least recently used ID from the frecency data.
    const idToRemove = recentSelections.pop();

    frecency.recentSelections = [
      selectedId,
      ...recentSelections
    ];

    const selectionById = frecency.selections[idToRemove];
    if (!selectionById) return;
    delete frecency.selections[idToRemove];

    Object.keys(selectionById.queries).forEach((query) => {
      frecency.queries[query] = frecency.queries[query].filter((selection) => {
        return selection.id !== idToRemove;
      });

      if (frecency.queries[query].length === 0) {
        delete frecency.queries[query];
      }
    });
  }

  sort({ searchQuery, results, idAttribute }: SortParams) {
    this._calculateFrecencyScores(results, searchQuery, idAttribute);

    // For recent selections, sort by frecency. Otherwise, fall back to
    // server-side sorting.
    const recentSelections = results.filter((result) => result._frecencyScore > 0);
    const otherSelections = results.filter((result) => result._frecencyScore === 0);

    return [
      ...recentSelections.sort((b, a) => b._frecencyScore - a._frecencyScore),
      ...otherSelections
    ];
  }

  _calculateFrecencyScores(results: Object[], searchQuery: string, idAttribute: string): void {
    const now = Date.now();

    results.forEach((result) => {
      const resultId = result[idAttribute];

      // Try calculating frecency score by exact query match.
      const frecencyForQuery = this._frecency.queries[searchQuery];

      if (frecencyForQuery) {
        const selection = frecencyForQuery.find((selection) => {
          return selection.id === resultId;
        });

        if (selection) {
          result._frecencyScore = this._calculateScore(selection.selectedAt,
            selection.timesSelected, now);
          return;
        }
      }

      // Try calculating frecency score by sub-query match.
      const subQueries = Object.keys(this._frecency.queries).filter((query) => {
        return query.startsWith(searchQuery);
      });

      for (let i = 0; i < subQueries.length; ++i) {
        const subQuery = subQueries[i];
        const selection = this._frecency.queries[subQuery].find((selection) => {
          return selection.id === resultId;
        });

        if (selection) {
          // Reduce the score because this is not an exact query match.
          result._frecencyScore = 0.75 * this._calculateScore(selection.selectedAt,
            selection.timesSelected, now);
          return;
        }
      }

      // Try calculating frecency score by ID.
      const selection = this._frecency.selections[resultId];
      if (selection) {
        // Reduce the score because this is not an exact query match.
        result._frecencyScore = 0.5 * this._calculateScore(selection.selectedAt,
          selection.timesSelected, now);
        return;
      }

      result._frecencyScore = 0;
    });
  }

  _calculateScore(timestamps: number[], timesSelected: number, now: number): number {
    if (timestamps.length === 0) return 0;

    const hour = 1000 * 60 * 60;
    const day = 24 * hour;

    const totalScore = timestamps.reduce((score, timestamp) => {
      if (timestamp >= now - 3 * hour) return score + 100;
      if (timestamp >= now - day) return score + 80;
      if (timestamp >= now - 3 * day) return score + 60;
      if (timestamp >= now - 7 * day) return score + 30;
      if (timestamp >= now - 14 * day) return score + 10;
      return score;
    }, 0);

    return timesSelected * (totalScore / timestamps.length);
  }
}

export default Frecency;