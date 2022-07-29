import axios from '~/lib/utils/axios_utils'
import csrf from '~/lib/utils/csrf'
import gql from 'graphql-tag'
import graphqlClient from 'oc/graphql-shim'
import {postFormDataWithEntries} from './forms.js'

const getUserProjectsQuery = gql`
query getUserProjects {
    currentUser {
        projectMemberships {
            nodes {
                accessLevel {
                    integerValue
                }
                project {
                    fullPath
                    name
                }
            }
        }
    }
}
`

export async function fetchUserProjects(_options) {
    const options = Object.assign({
        minimumAccessLevel: 30
    }, _options)

    const response = await graphqlClient.clients.defaultClient.query({
        query: getUserProjectsQuery
    })

    const nodes = response.data?.currentUser?.projectMemberships?.nodes || []

    return nodes
        .filter(node => node.accessLevel.integerValue >= options.minimumAccessLevel && node.project.name != 'dashboard')
        .map(node => node.project)
}

const getUserPublicEmailQuery = gql`
query getUserPublicEmail {
    currentUser {
      publicEmail
    }
}
`

export async function fetchUserPublicEmail() {
    const response = await graphqlClient.clients.defaultClient.query({
        query: getUserPublicEmailQuery
    })

    return response.data?.currentUser?.publicEmail || null // using || because it defaults to an empty string
}


export async function generateAccessToken(tokenName, options) {
    const {scopes, expiresAt} = Object.assign({
        scopes: ['api', 'read_user', 'read_api', 'read_repository', 'write_repository', 'read_registry', 'write_registry'],
        expiresAt: ''
    }, options)

    const baseURL = '/-/profile/personal_access_tokens'
    const data = [
        ['authenticity_token', csrf.token],
        ['personal_access_token[name]', tokenName],
        ['personal_access_token[expires_at]', expiresAt],
    ]

    for(const scope of scopes) {
        data.push(['personal_access_token[scopes][]', scope])
    }

    const query = data.map(entry => `${encodeURIComponent(entry[0])}=${encodeURIComponent(entry[1])}`).join('&')

    const response = await axios.post(
        baseURL,
        query,
        {
            headers: {
                'Accept': 'text/html,application/xhtml+xml,application/xml',
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        }
    )

    const domParser = new DOMParser()
    const dom = domParser.parseFromString(response.data, 'text/html')
    return dom.querySelector('#created-personal-access-token')?.value
}