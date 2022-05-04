const BASE_URL = Cypress.env('OC_URL')
const REPOS_NAMESPACE = Cypress.env('REPOS_NAMESPACE')

describe('Sanity check', () => {
  it('Can access a store', () => {
    cy.visit(`${BASE_URL}/${REPOS_NAMESPACE}/simple-blueprint`)
    cy.window().should('have.property', '$store')
  })
})